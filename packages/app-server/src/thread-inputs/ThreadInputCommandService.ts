import { type StoredThreadInput, type ThreadInputMutation, type ThreadInputScope } from "@repo/event-store";
import {
  StartQueuedThreadInputCommandSchema,
  ThreadInputCommandSchema,
  ThreadInputReceiptSchema,
  type ThreadInputCommand,
  type ThreadInputQueueSnapshot,
  type ThreadInputReceipt,
  type ResumeTurnReceipt,
} from "@repo/platform-protocol";
import type { InputCommand, PreparedThreadInputMedia, ThreadInputCommandPorts } from "./ports.js";

export class ThreadInputCommandError extends Error {
  constructor(readonly statusCode: 400 | 404 | 503, readonly operationCode: string, message: string) {
    super(message);
    this.name = "ThreadInputCommandError";
  }
}
export type ThreadInputCommandOutcome = {
  readonly statusCode: 200 | 201 | 202 | 409;
  readonly result: ThreadInputReceipt | ThreadInputQueueSnapshot | ResumeTurnReceipt;
};

/** Shared hosted/local command owner. Durable CAS/admission and lifecycle
 * projections remain on the injected original writer, never this object. */
export class ThreadInputCommandService {
  constructor(private readonly ports: ThreadInputCommandPorts) {}

  async execute(raw: ThreadInputCommand): Promise<ThreadInputCommandOutcome> {
    const command = ThreadInputCommandSchema.parse(raw);
    const scope = await this.ports.authorize(command);
    let result: ThreadInputCommandOutcome;
    switch (command.operation) {
      case "thread.input.list":
        result = { statusCode: 200, result: await this.ports.repository.list(scope) };
        break;
      case "thread.input.enqueue": result = await this.enqueue(scope, command); break;
      case "turn.steer": result = await this.steer(scope, command); break;
      case "thread.input.steer": result = await this.steerQueued(scope, command); break;
      case "thread.input.update": result = await this.update(scope, command); break;
      case "thread.input.remove":
        result = mutationOutcome(await this.ports.repository.remove({ ...scope, itemId: command.itemId, expectedVersion: command.expectedVersion }));
        break;
      case "thread.input.start":
        result = await this.start(scope, command, true);
        break;
      case "turn.resume":
        if (!this.ports.resume) throw new ThreadInputCommandError(503, "THREAD_RESUME_UNAVAILABLE", "Resume is unavailable in this execution environment.");
        result = { statusCode: 202, result: await this.ports.resume(scope, command) };
        break;
    }
    // Scope replacement/revocation during any read cannot disclose its result.
    await this.ports.authorize(command);
    return result;
  }

  async onTurnTerminal(input: ThreadInputScope & { type: "turn.completed" | "turn.failed" | "turn.interrupted" }): Promise<void> {
    if (input.type !== "turn.completed") return;
    await this.tryAdvance(input);
  }

  private async enqueue(scope: ThreadInputScope, command: InputCommand<"thread.input.enqueue">): Promise<ThreadInputCommandOutcome> {
    await this.ports.validateConfiguration(command.configuration);
    const inputId = await canonicalThreadInputId(scope, command.clientInputId);
    const media = await this.ports.prepareMedia({ scope, inputId, clientInputId: command.clientInputId, mediaRevision: 1, images: command.content.images });
    try {
      await this.ports.authorize(command);
      const stored = await this.ports.repository.enqueue({
        ...scope, itemId: inputId, clientInputId: command.clientInputId,
        fingerprint: await fingerprint({ operation: command.operation, text: command.content.text, mediaRefs: media.references,
          configuration: command.configuration }),
        delivery: "queue", text: command.content.text, mediaRefs: [...media.references], configuration: command.configuration,
        mediaFingerprint: media.fingerprint, mediaRevision: media.mediaRevision,
      });
      const receipt = stored.item.receipt ?? pendingReceipt(stored.item, stored.revision);
      if (stored.item.state === "pending") await this.tryAdvance(scope);
      return { statusCode: stored.duplicate ? 200 : 201, result: receipt };
    } finally { await discard(media); }
  }

  private async steer(scope: ThreadInputScope, command: InputCommand<"turn.steer">): Promise<ThreadInputCommandOutcome> {
    const targetConflict = await this.ports.assertSteeringTarget(scope, command, command.content.images.length > 0);
    if (targetConflict) return { statusCode: 409, result: targetConflict };
    const inputId = await canonicalThreadInputId(scope, command.clientInputId);
    const media = await this.ports.prepareMedia({ scope, inputId, clientInputId: command.clientInputId, mediaRevision: 1, images: command.content.images });
    try {
      await this.ports.authorize(command);
      const stored = await this.ports.repository.enqueue({
        ...scope, itemId: inputId, clientInputId: command.clientInputId,
        fingerprint: await fingerprint({ operation: command.operation, text: command.content.text, mediaRefs: media.references,
          targetTurnId: command.expectedTurnId, targetRunAttemptId: command.expectedRunAttemptId }),
        delivery: "steer", targetTurnId: command.expectedTurnId, targetRunAttemptId: command.expectedRunAttemptId,
        text: command.content.text, mediaRefs: [...media.references], configuration: {},
        mediaFingerprint: media.fingerprint, mediaRevision: media.mediaRevision,
      });
      return await this.deliver(scope, stored.item, stored.duplicate ? 200 : 202);
    } finally { await discard(media); }
  }

  private async steerQueued(scope: ThreadInputScope, command: InputCommand<"thread.input.steer">): Promise<ThreadInputCommandOutcome> {
    let item = await this.requiredItem(scope, command.itemId);
    if (item.delivery === "steer" && (item.targetTurnId !== command.expectedTurnId || item.targetRunAttemptId !== command.expectedRunAttemptId))
      return conflict("target_superseded", "This input is already bound to a different turn attempt.");
    if (isDeliveryReceipt(item.receipt)) return { statusCode: 200, result: item.receipt };
    const targetConflict = await this.ports.assertSteeringTarget(scope, command, item.mediaRefs.length > 0);
    if (targetConflict) return { statusCode: 409, result: targetConflict };
    await this.ports.authorize(command);
    if (item.delivery === "queue") {
      const claimed = await this.ports.repository.claimForSteering({ ...scope, itemId: item.itemId, expectedVersion: command.expectedVersion,
        targetTurnId: command.expectedTurnId, targetRunAttemptId: command.expectedRunAttemptId });
      if (claimed.status === "conflict") return conflict(claimed.code, "Queue item changed or was already consumed.");
      item = claimed.item;
    }
    return this.deliver(scope, item, 202);
  }

  private async deliver(scope: ThreadInputScope, item: StoredThreadInput, statusCode: 200 | 202): Promise<ThreadInputCommandOutcome> {
    if (isDeliveryReceipt(item.receipt)) return { statusCode: 200, result: item.receipt };
    let delivered: Awaited<ReturnType<ThreadInputCommandPorts["deliverSteer"]>>;
    try { delivered = await this.ports.deliverSteer(scope, item); }
    catch {
      await this.pauseUnknown(scope);
      throw unknownDelivery();
    }
    if ("status" in delivered) {
      const changed = await this.ports.repository.recordReceipt({ ...scope, itemId: item.itemId, expectedVersion: item.version,
        receipt: delivered, state: "cancelled" });
      if (changed.status === "conflict") {
        const current = await this.requiredItem(scope, item.itemId);
        if (isDeliveryReceipt(current.receipt)) return { statusCode: 200, result: current.receipt };
        await this.pauseUnknown(scope);
        throw unknownDelivery();
      }
      return { statusCode: 409, result: delivered };
    }
    const current = await this.requiredItem(scope, item.itemId);
    if (!isDeliveryReceipt(current.receipt) ||
        (current.receipt.status !== "unconfirmed" && current.receipt.acceptedSequence !== delivered.acceptedSequence)) {
      await this.pauseUnknown(scope);
      throw unknownDelivery();
    }
    return { statusCode, result: current.receipt };
  }

  private async update(scope: ThreadInputScope, command: InputCommand<"thread.input.update">): Promise<ThreadInputCommandOutcome> {
    if (command.configuration) await this.ports.validateConfiguration(command.configuration);
    const existing = await this.requiredItem(scope, command.itemId);
    const effectiveImages = command.content.images ?? existing.mediaRefs;
    if (!command.content.text.trim() && !effectiveImages.length)
      throw new ThreadInputCommandError(400, "THREAD_INPUT_CONTENT_INVALID", "Provide text or at least one image.");
    let media: PreparedThreadInputMedia | undefined;
    try {
      if (command.content.images !== undefined) media = await this.ports.prepareMedia({ scope, inputId: command.itemId,
        clientInputId: existing.clientInputId, mediaRevision: command.expectedVersion + 1, images: command.content.images });
      await this.ports.authorize(command);
      return mutationOutcome(await this.ports.repository.update({ ...scope, itemId: command.itemId, expectedVersion: command.expectedVersion,
        text: command.content.text, ...(media ? { mediaRefs: [...media.references], mediaFingerprint: media.fingerprint, mediaRevision: media.mediaRevision } : {}),
        ...(command.configuration ? { configuration: command.configuration } : {}) }));
    } finally { if (media) await discard(media); }
  }

  private async start(scope: ThreadInputScope, command: InputCommand<"thread.input.start">, explicitStart: boolean): Promise<ThreadInputCommandOutcome> {
    await this.ports.authorize(command);
    // The physical adapter distinguishes known pre-admission failures from an
    // ambiguous dispatch and pauses its durable owner before surfacing unknown.
    const result = await this.ports.startQueued({ scope, command, explicitStart });
    return { statusCode: result.status === "conflict" ? 409 : 202, result };
  }

  private async tryAdvance(scope: ThreadInputScope): Promise<void> {
    await advanceThreadInputQueue(scope, {
      repository: this.ports.repository,
      startQueued: async (input) => (await this.start(input.scope, input.command, input.explicitStart)).result as ThreadInputReceipt,
    });
  }

  private async requiredItem(scope: ThreadInputScope, itemId: string): Promise<StoredThreadInput> {
    const item = await this.ports.repository.getById({ ...scope, itemId });
    if (!item) throw new ThreadInputCommandError(404, "QUEUE_ITEM_NOT_FOUND", "Queue item not found.");
    return item;
  }
  private async pauseUnknown(scope: ThreadInputScope): Promise<void> {
    await this.ports.repository.setPaused({ ...scope, paused: true, reason: "Input delivery or resource cleanup requires reconciliation." });
  }
}

/** Common completed-turn/idle enqueue policy. Adapters retain physical proof and
 * canonical admission; this function never delivers an input itself. */
export async function advanceThreadInputQueue(scope: ThreadInputScope,
  ports: Pick<ThreadInputCommandPorts, "repository" | "startQueued">): Promise<void> {
  const snapshot = await ports.repository.list(scope);
  if (snapshot.paused || snapshot.activeRunId) return;
  const next = snapshot.items.find((item) => item.delivery === "queue" && item.state === "pending");
  if (!next) return;
  // This is logical eligibility only. The actual start adapter verifies held
  // physical successor authority and predecessor closure before admission.
  try {
    await ports.startQueued({ scope, explicitStart: false,
      command: StartQueuedThreadInputCommandSchema.parse({ operation: "thread.input.start", threadId: scope.threadId,
        workspaceId: scope.workspaceId, itemId: next.itemId, expectedVersion: next.version, expectedThreadRevision: snapshot.revision }) });
  } catch { /* The original adapter owns any ambiguous dispatch; never resend here. */ }
}

function pendingReceipt(item: StoredThreadInput, revision: number): ThreadInputReceipt {
  return ThreadInputReceiptSchema.parse({ status: "pending", clientInputId: item.clientInputId, itemId: item.itemId,
    order: item.order, version: item.version, revision });
}
function mutationOutcome(result: ThreadInputMutation): ThreadInputCommandOutcome {
  if (result.status === "conflict") return conflict(result.code, "Queue item changed or was already consumed.");
  return { statusCode: 200, result: result.item.receipt ?? pendingReceipt(result.item, result.revision) };
}
function conflict(code: Extract<ThreadInputReceipt, { status: "conflict" }>["code"], message: string): ThreadInputCommandOutcome {
  return { statusCode: 409, result: ThreadInputReceiptSchema.parse({ status: "conflict", code, message }) };
}
function isDeliveryReceipt(receipt: ThreadInputReceipt | null): receipt is Extract<ThreadInputReceipt, { status: "accepted" | "applied" | "unconfirmed" }> {
  return receipt?.status === "accepted" || receipt?.status === "applied" || receipt?.status === "unconfirmed";
}
async function discard(media: PreparedThreadInputMedia): Promise<void> {
  try { await media.discardUnpublished(); } catch { /* The original media owner retains unknown cleanup. */ }
}
function unknownDelivery(): ThreadInputCommandError {
  return new ThreadInputCommandError(503, "THREAD_INPUT_OUTCOME_UNKNOWN", "Input delivery is being reconciled. Keep the same input identity.");
}
async function fingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function canonicalThreadInputId(scope: ThreadInputScope, clientInputId: string): Promise<string> {
  const hex = await fingerprint([scope.userId, scope.workspaceId, scope.threadId, clientInputId]);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
