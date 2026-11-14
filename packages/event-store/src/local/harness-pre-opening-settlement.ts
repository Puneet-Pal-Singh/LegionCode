import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  HarnessAdmissionSelectionSchema,
  LifecycleEventSchema,
  PlatformEventSchema,
  TurnAdmissionSchema,
  type LifecycleEvent,
  type TurnAdmission,
} from "@repo/platform-protocol";
import { LocalPersistenceError } from "../errors.js";
import { createStableEventFingerprint } from "../fingerprint.js";
import { platformFingerprint } from "../local-platform-fingerprint.js";
import type { LocalTurnAdmissions } from "../local-turn-admissions.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
type FailureTerminal = Extract<LifecycleEvent, { type: "turn.failed" | "turn.interrupted" }>;
const FailureTerminalSchema = LifecycleEventSchema.refine(
  (event): event is FailureTerminal => event.type === "turn.failed" || event.type === "turn.interrupted",
  "Pre-opening settlement requires a failed or interrupted canonical terminal",
);

/** Canonical facts only. The P11 repository adds its current dispatch state. */
export const CanonicalPreOpeningSettlementSchema = z.object({
  admission: TurnAdmissionSchema,
  admissionSha256: sha256,
  capture: HarnessAdmissionSelectionSchema.refine((value) => value.selection !== null),
  terminal: FailureTerminalSchema,
  terminalSha256: sha256,
  historySha256: sha256,
  historyEventCount: z.number().int().positive().safe(),
}).strict();

type EventRow = {
  event_json: string; event_id: string; thread_id: string; turn_id: string | null;
  stream_type: string; stream_id: string; sequence: number; cursor: string | null;
  idempotency_key: string; fingerprint: string;
};
const indexedColumns = "event_json,event_id,thread_id,turn_id,stream_type,stream_id,sequence,cursor,idempotency_key,fingerprint";

/** Invoked synchronously inside the existing P11 writer transaction. Does not
 * append, settle, reconstruct a snapshot, or create an execution/opening claim. */
export function readCanonicalPreOpeningSettlement(
  database: Database.Database,
  admissions: Pick<LocalTurnAdmissions, "getByTurn"> | undefined,
  expected: TurnAdmission,
): z.infer<typeof CanonicalPreOpeningSettlementSchema> | null {
  const requested = TurnAdmissionSchema.parse(expected);
  const admission = admissions?.getByTurn(requested.turn.id);
  if (!admission || digest(admission) !== digest(requested)) return null;
  if (admission.run.executionCapability !== "repository" || admission.userMessage.type !== "user_message") return null;
  const capture = HarnessAdmissionSelectionSchema.safeParse(admission.run.harnessSelection);
  const contentCapture = HarnessAdmissionSelectionSchema.safeParse(admission.userMessage.content.harnessSelection);
  const environment = database.prepare("SELECT value FROM metadata WHERE key='local_environment_id_v1'")
    .get() as { value: string } | undefined;
  if (!capture.success || capture.data.selection === null || !contentCapture.success ||
      digest(capture.data) !== digest(contentCapture.data) || environment?.value !== capture.data.environmentId ||
      capture.data.selection.modelId !== admission.run.modelId) return null;

  const index = database.prepare("SELECT run_event_id,turn_event_id,prompt_event_id FROM turn_admissions WHERE turn_id=?")
    .get(admission.turn.id) as { run_event_id: string; turn_event_id: string; prompt_event_id: string } | undefined;
  if (!index) throw corrupt("Pre-opening admission index disappeared");
  for (const [offset, id] of [index.run_event_id, index.turn_event_id, index.prompt_event_id].entries()) {
    const row = database.prepare(`SELECT ${indexedColumns} FROM events WHERE family='platform' AND event_id=?`)
      .get(id) as EventRow | undefined;
    if (!row) throw corrupt("Pre-opening canonical admission reference is missing");
    const event = PlatformEventSchema.parse(JSON.parse(row.event_json));
    if (event.eventId !== id || event.threadId !== admission.run.threadId ||
        event.workspaceId !== admission.run.workspaceId || event.runId !== admission.run.id ||
        event.scopeType !== "run" || event.scopeId !== admission.run.id || event.sequence !== offset + 1 ||
        event.producer.kind !== "runtime_kernel" || event.producer.id !== "local-admission" ||
        row.event_id !== event.eventId || row.thread_id !== event.threadId || row.turn_id !== null ||
        row.stream_type !== event.scopeType || row.stream_id !== event.scopeId || row.sequence !== event.sequence ||
        row.cursor !== event.cursor || row.idempotency_key !== event.idempotencyKey || row.fingerprint !== platformFingerprint(event))
      throw corrupt("Pre-opening admission indices conflict with canonical ownership");
  }

  const history = database.prepare(`SELECT ${indexedColumns} FROM events
    WHERE family='lifecycle' AND (stream_id=? OR turn_id=?) ORDER BY sequence`)
    .iterate(admission.turn.id, admission.turn.id) as Iterable<EventRow>;
  const historyDigest = createHash("sha256");
  const starts = ["turn.queued", "turn.started", "run_attempt.started"];
  let count = 0;
  let previous: LifecycleEvent | null = null;
  let terminal: FailureTerminal | null = null;
  for (const row of history) {
    const event = LifecycleEventSchema.parse(JSON.parse(row.event_json));
    if (terminal || event.sequence !== count + 1 || event.threadId !== admission.run.threadId ||
        event.turnId !== admission.turn.id || event.runAttemptId !== admission.runAttemptId ||
        event.producer.id !== admission.run.workerId || row.event_id !== event.eventId ||
        row.thread_id !== event.threadId || row.turn_id !== event.turnId || row.stream_type !== "turn" ||
        row.stream_id !== event.turnId || row.sequence !== event.sequence || row.cursor !== null ||
        row.idempotency_key !== event.idempotencyKey || row.fingerprint !== createStableEventFingerprint(event))
      throw corrupt("Pre-opening lifecycle scope, producer, sequence or fingerprint is inconsistent");
    if ((count < starts.length && event.type !== starts[count]) ||
        (count >= starts.length && starts.includes(event.type)))
      throw corrupt("Pre-opening lifecycle has no unique canonical start prefix");
    if (event.type === "turn.completed") return null;
    if (event.type === "turn.failed" || event.type === "turn.interrupted") {
      if (!previous || previous.type !== (event.type === "turn.failed" ? "run_attempt.failed" : "run_attempt.interrupted") ||
          (event.type === "turn.failed" && createStableEventFingerprint(previous.payload.failure) !== createStableEventFingerprint(event.payload.outcome.failure)))
        throw corrupt("Pre-opening terminal has no matching canonical attempt settlement");
      terminal = event;
    }
    historyDigest.update(createStableEventFingerprint(event)).update("\n");
    count += 1;
    previous = event;
  }
  if (!terminal) return null;
  return CanonicalPreOpeningSettlementSchema.parse({
    admission, admissionSha256: digest(admission), capture: capture.data,
    terminal, terminalSha256: digest(terminal), historySha256: historyDigest.digest("hex"), historyEventCount: count,
  });
}

function digest(value: unknown): string {
  return createHash("sha256").update(createStableEventFingerprint(value)).digest("hex");
}
function corrupt(message: string): LocalPersistenceError {
  return new LocalPersistenceError("corrupt", message);
}
