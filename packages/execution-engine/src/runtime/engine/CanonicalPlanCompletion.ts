import {
  LifecycleEventSchema, RunSchema, TurnSchema,
  type LifecycleEvent, type Run as ProtocolRun, type RunAttemptId, type Turn,
} from "@repo/platform-protocol";
import type { RuntimeLifecycleEventStore } from "@repo/runtime-kernel";
import { PlanSchema, type Plan } from "../planner/index.js";
import { Run } from "../run/index.js";
import { buildPlanModeResponse, persistPlanArtifact } from "./RunPlanModePolicy.js";

/** An immutable snapshot of the structured planner result, never request metadata. */
export interface CapturedPlanCompletion {
  readonly plan: string;
  readonly artifact: string;
  readonly output: string;
}

export interface CanonicalPlanCompletion {
  readonly lifecycleEvents: RuntimeLifecycleEventStore;
  readonly run: ProtocolRun;
  readonly turn: Turn;
  readonly runAttemptId: RunAttemptId;
  readonly captured: CapturedPlanCompletion | null;
}

export function capturePlanCompletion(run: Run, value: Plan): CapturedPlanCompletion {
  const plan = PlanSchema.parse(value);
  const artifact = persistPlanArtifact(run, plan);
  return Object.freeze({
    plan: JSON.stringify(plan), artifact: JSON.stringify(artifact), output: buildPlanModeResponse(artifact),
  });
}

/** Read the real kernel terminal and final item before projecting legacy run state. */
export async function readCanonicalPlanTerminal(run: Run, input: CanonicalPlanCompletion): Promise<{
  readonly terminal: Extract<LifecycleEvent, { type: "turn.completed" | "turn.failed" | "turn.interrupted" }>;
  readonly output: string;
}> {
  const protocolRun = RunSchema.parse(input.run);
  const turn = TurnSchema.parse(input.turn);
  if (run.metadata.manifest?.mode !== "plan" || protocolRun.mode !== "plan" ||
    protocolRun.executionCapability !== "repository" || protocolRun.id !== run.id || turn.runId !== run.id ||
    turn.threadId !== protocolRun.threadId) throw invalid();

  const events: LifecycleEvent[] = [];
  let afterSequence = 0;
  while (true) {
    const page = await input.lifecycleEvents.replay({ turnId: turn.id, afterSequence, limit: 100 });
    if (page.events.length > 100 || events.length + page.events.length > 512) throw invalid();
    for (const value of page.events) {
      const event = LifecycleEventSchema.parse(value);
      if (event.turnId !== turn.id || event.threadId !== protocolRun.threadId ||
        event.runAttemptId !== input.runAttemptId || event.sequence !== events.length + 1 ||
        event.producer.kind !== "runtime_kernel" || event.producer.id !== "runtime-kernel-native") throw invalid();
      if (event.type.startsWith("tool_call.") || event.type.startsWith("approval.") ||
        event.type.startsWith("hook.") || event.type.startsWith("workspace.") || event.type === "artifact.created") throw invalid();
      events.push(event);
    }
    if (page.nextSequence === null) break;
    if (page.events.length === 0 || page.nextSequence !== events.at(-1)?.sequence) throw invalid();
    afterSequence = page.nextSequence;
  }
  const terminals = events.filter((event): event is Extract<LifecycleEvent, {
    type: "turn.completed" | "turn.failed" | "turn.interrupted";
  }> => event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.interrupted");
  const terminal = terminals[0];
  if (!terminal || terminals.length !== 1 || terminal !== events.at(-1) ||
    events[0]?.type !== "turn.queued" || events[1]?.type !== "turn.started" || events[2]?.type !== "run_attempt.started") throw invalid();

  const itemId = `itm_${turn.id.slice(4)}_plan`;
  const deltas = events.filter((event) => event.type === "assistant_message.delta");
  if (deltas.some((event) => event.type !== "assistant_message.delta" || event.itemId !== itemId ||
    event.payload.phase !== "final_answer")) throw invalid();
  const output = deltas.flatMap((event) => event.type === "assistant_message.delta" ? [event.payload.delta] : []).join("");
  if (terminal.type === "turn.completed") {
    const captured = input.captured;
    if (!captured) throw invalid();
    const plan = PlanSchema.parse(JSON.parse(captured.plan));
    const artifact = run.metadata.planArtifact;
    if (!artifact || JSON.stringify(artifact) !== captured.artifact || !Number.isFinite(Date.parse(artifact.createdAt))) throw invalid();
    // Reuse the plan/artifact owner to verify all task and handoff fields.
    const copy = Run.fromJSON({ ...run.toJSON(), metadata: { ...run.metadata } });
    const expected = persistPlanArtifact(copy, plan);
    expected.createdAt = artifact.createdAt;
    if (JSON.stringify(expected) !== captured.artifact || buildPlanModeResponse(artifact) !== captured.output || output !== captured.output) throw invalid();
    const started = events.filter((event): event is LifecycleEvent & { type: "item.started" } => event.type === "item.started");
    const completed = events.filter((event) => event.type === "item.completed");
    if (started.length !== 1 || started[0]?.itemId !== itemId || started[0]?.payload.kind !== "assistant_message" ||
      completed.length !== 1 || completed[0]?.itemId !== itemId || completed[0]?.payload.result.output !== output ||
      events.at(-2)?.type !== "run_attempt.succeeded") throw invalid();
    if (deltas.some((event) => event.sequence <= started[0]!.sequence || event.sequence >= completed[0]!.sequence)) throw invalid();
  } else if (output && (!input.captured || !input.captured.output.startsWith(output))) {
    throw invalid();
  }
  return { terminal, output };
}

function invalid(): Error {
  return new Error("Canonical structured plan completion evidence is unavailable or mismatched.");
}
