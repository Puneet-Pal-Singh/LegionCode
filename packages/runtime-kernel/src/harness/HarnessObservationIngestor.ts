import type { HarnessSelection, ToolCallId } from "@repo/platform-protocol";
import { HarnessCommitAckSchema, HarnessObservationSchema, type HarnessCommitAck, type HarnessObservation, type HarnessSession } from "@repo/worker-protocol";
import { RuntimeLifecycleCoordinator } from "../RuntimeLifecycleCoordinator.js";
import { RuntimeKernelError } from "../errors.js";
import type { HarnessObservationCommitPort } from "./DelegatedHarnessPort.js";

export function sameHarnessSession(a: HarnessSession, b: HarnessSession): boolean {
  return a.runAttemptId === b.runAttemptId && a.instanceId === b.instanceId &&
    a.externalSessionId === b.externalSessionId && a.processGeneration === b.processGeneration;
}

type Terminal = Extract<HarnessObservation["payload"], { kind: "external_terminal" }>;
type Approval = Extract<HarnessObservation["payload"], { kind: "approval_requested" }>;

/** Private ingress validates before translation. Persistence owns replay/deduplication. */
export class HarnessObservationIngestor {
  private readonly tools = new Map<string, ToolCallId>();
  private externalTurnId: string | null = null;
  private terminal: Terminal | null = null;
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private readonly requestOrigins = new Set<string>();

  constructor(private readonly options: {
    readonly selection: HarnessSelection;
    readonly session: HarnessSession;
    readonly lifecycle: RuntimeLifecycleCoordinator;
    readonly persistence: HarnessObservationCommitPort;
    readonly onApproval: (approval: Approval) => void;
  }) {}

  get terminalObservation(): Terminal | null { return this.terminal; }

  async observe(input: unknown): Promise<HarnessCommitAck> {
    // Serialize translation and post-commit effects, including callers that fail
    // to await delivery. The host must separately bound its delivery journal.
    if (this.pending >= 64) this.reject("Harness ingress buffer is full; delivery must pause");
    const observation = HarnessObservationSchema.parse(input);
    this.pending += 1;
    const operation = this.queue.then(() => this.ingest(observation)).finally(() => { this.pending -= 1; });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async ingest(input: unknown): Promise<HarnessCommitAck> {
    const observation = HarnessObservationSchema.parse(input);
    const { session, selection, persistence, lifecycle } = this.options;
    if (!sameHarnessSession(observation.session, session)) this.reject("Stale harness observation session");
    // This lookup validates immutable payload fingerprint as well as identity.
    // A committed duplicate can be ACKed even after terminal settlement.
    const existing = await persistence.lookup(observation);
    if (existing) return this.validateAck(existing, observation);
    if (this.terminal && observation.payload.kind !== "quiescence") this.reject("Observation follows external terminal");
    if (this.externalTurnId !== null && observation.externalTurnId !== this.externalTurnId) this.reject("External turn identity changed");
    const payload = observation.payload;
    if (payload.kind === "approval_requested") {
      if (this.requestOrigins.has(JSON.stringify(payload.replyTo))) this.reject("Approval request origin was reused");
      if (!sameHarnessSession(payload.replyTo.session, session) ||
        payload.replyTo.authOwnerGeneration !== selection.authOwnerGeneration) this.reject("Stale approval origin");
      if (payload.request.itemId === null || payload.request.itemId === payload.parentItemId) this.reject("Invalid approval item");
    }
    if (payload.kind === "quiescence" && !sameHarnessSession(payload.evidence.session, session)) this.reject("Stale quiescence evidence");
    let applied = false;
    const ack = await lifecycle.commitHarnessObservation(observation, persistence, async (draft) => {
      applied = true;
      switch (payload.kind) {
        case "assistant_text":
          await draft.appendAssistantCommentary(payload.itemId, payload.text); break;
        case "tool_started":
          await draft.startToolCall(payload.itemId, payload.content.toolCallId, payload.content.toolName, payload.content.input); break;
        case "tool_completed": {
          const tool = this.tools.get(payload.itemId);
          if (!tool) this.reject("Tool completion has no matching start");
          await draft.appendToolOutput(tool, payload.output);
          await draft.completeToolCall(tool, { output: payload.output }); break;
        }
        case "approval_requested":
          await draft.requestApproval(payload.parentItemId, payload.request.approvalId,
            payload.request.itemId!, { question: payload.request.question, options: payload.request.options, metadata: payload.request.metadata }); break;
        case "usage": await draft.updateUsage(payload.usage); break;
        // External terminal/quiescence are durable ingress evidence. They never
        // independently decide canonical turn success or release the lease.
        case "external_terminal": case "quiescence": break;
      }
    });
    this.validateAck(ack, observation);
    if (applied) {
      this.externalTurnId ??= observation.externalTurnId;
      if (payload.kind === "tool_started") this.tools.set(payload.itemId, payload.content.toolCallId);
      if (payload.kind === "tool_completed") this.tools.delete(payload.itemId);
      if (payload.kind === "external_terminal") this.terminal = payload;
      if (payload.kind === "approval_requested") {
        this.requestOrigins.add(JSON.stringify(payload.replyTo));
        this.options.onApproval(payload);
      }
    }
    return ack;
  }

  private validateAck(input: HarnessCommitAck, observation: HarnessObservation): HarnessCommitAck {
    const ack = HarnessCommitAckSchema.parse(input);
    if (!sameHarnessSession(ack.session, observation.session) || ack.committedSequence !== observation.sequence) this.reject("Observation ACK identity mismatch");
    return ack;
  }

  private reject(message: string): never { throw new RuntimeKernelError("worker_failed", message); }
}
