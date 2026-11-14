import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  createStableEventFingerprint, LocalNativeResourceSettlementSchema,
  type LocalNativeResourceSettlement,
} from "@repo/event-store";
import type { LocalPersistence } from "@repo/event-store/local";
import { LocalTurnConfigurationSchema, TurnAdmissionSchema, type TurnAdmission } from "@repo/platform-protocol";
import { parseNativeGitMetadataIdentity } from "@legioncode/execution-engine/runtime/desktop/NativeFilesystemBridge";
import { readLocalTurnArtifactPublication } from "./local-turn-artifact-publication.js";
import type { LocalTurnBindingClosure } from "./local-turn-resources.js";
import type { LocalWorkspaceExecutionBinding } from "./local-workspace.js";
import type { LocalWorkspaceWriterLease, LocalWorkspaceWriterReleaseReceipt } from "./local-workspace-writer-lease.js";
import { AppServerOperationError } from "./server.js";

type Persistence = Pick<LocalPersistence, "turnAdmissions" | "lifecycleEvents" | "turnArtifacts">;
type Capture = LocalNativeResourceSettlement["artifactCapture"];
type WriterFence = LocalNativeResourceSettlement["writerFence"];

/** Invoked only after the same executor positively released its original work.
 * The returned completion must run after the original binding.close fulfills. */
export async function prepareLocalNativeSettlement(input: {
  persistence: Persistence;
  admission: TurnAdmission;
  binding: LocalWorkspaceExecutionBinding;
  artifactCapture: Capture;
  writerFence: WriterFence;
  releasedWriter?: LocalWorkspaceWriterReleaseReceipt;
}): Promise<(closure: LocalTurnBindingClosure) => Promise<void>> {
  const facts = await readCanonicalFacts(input.persistence, input.admission, input.artifactCapture);
  if (input.writerFence.kind === "not_acquired" &&
      (facts.artifacts.length || facts.terminal.status === "completed")) throw unavailable();
  return async (closure) => {
    if (closure.binding !== input.binding || input.binding.rootDirectory.fd !== -1 ||
        (input.writerFence.kind === "released" &&
          (!input.releasedWriter || !isDeepStrictEqual(input.releasedWriter.root, closure.root) ||
            input.releasedWriter.gitMetadataIdentity !== closure.gitMetadataIdentity))) throw unavailable();
    parseNativeGitMetadataIdentity(closure.gitMetadataIdentity);
    const record = LocalNativeResourceSettlementSchema.parse({
      formatVersion: 1, ...facts,
      root: closure.root, gitMetadataIdentity: closure.gitMetadataIdentity,
      grantedAt: closure.grantedAt, generation: closure.generation,
      writerFence: input.writerFence,
    });
    const store = input.persistence.turnArtifacts.forAttempt(facts.scope);
    // A failed acknowledgement is reconciled only against the same immutable
    // record, never with terminal history, a new lease or an absent owner map.
    try { await store.putNativeResourceSettlement(record); } catch { /* Re-read below. */ }
    const saved = await store.getNativeResourceSettlement();
    if (!saved || !isDeepStrictEqual(saved, record) ||
        !isDeepStrictEqual(await readCanonicalFacts(input.persistence, input.admission, input.artifactCapture), facts)) {
      throw unavailable();
    }
  };
}

/** Loan from the successor's already-held physical writer. This reader opens
 * no root, acquires no fence and exposes no execution capability. */
export async function verifyLocalNativePredecessorSettlement(input: {
  persistence: Persistence;
  predecessor: TurnAdmission;
  successor: TurnAdmission;
  lease: LocalWorkspaceWriterLease;
}): Promise<LocalNativeResourceSettlement> {
  const predecessor = TurnAdmissionSchema.parse(input.predecessor);
  const successor = TurnAdmissionSchema.parse(input.successor);
  const attempt = input.lease.attempt;
  if (predecessor.run.workspaceId !== successor.run.workspaceId ||
      predecessor.turn.id === successor.turn.id ||
      attempt.workspaceId !== successor.run.workspaceId || attempt.threadId !== successor.run.threadId ||
      attempt.runId !== successor.run.id || attempt.turnId !== successor.turn.id ||
      attempt.runAttemptId !== successor.runAttemptId) throw unavailable();
  return input.lease.withPredecessorVerification(async (physical) => {
    const store = input.persistence.turnArtifacts.forAttempt(scopeOf(predecessor));
    const saved = await store.getNativeResourceSettlement();
    // Missing historical evidence is explicitly unverified. A newly acquired
    // fence cannot reconstruct the previous process's release/binding receipt.
    if (!saved || !isDeepStrictEqual(saved.root, physical.root) || saved.gitMetadataIdentity !== physical.gitMetadataIdentity ||
        (saved.writerFence.kind === "released" &&
          !isDeepStrictEqual(saved.writerFence.identity, physical.writerFence))) throw unavailable();
    const facts = await readCanonicalFacts(input.persistence, predecessor, saved.artifactCapture);
    if (saved.writerFence.kind === "not_acquired" &&
        (facts.artifacts.length || facts.terminal.status === "completed")) throw unavailable();
    if (!isDeepStrictEqual(facts, {
      scope: saved.scope, admissionSha256: saved.admissionSha256, terminal: saved.terminal,
      artifactCapture: saved.artifactCapture, artifacts: saved.artifacts,
    })) throw unavailable();
    return saved;
  });
}

async function readCanonicalFacts(persistence: Persistence, input: TurnAdmission, artifactCapture: Capture) {
  const admission = TurnAdmissionSchema.parse(input);
  if (admission.userMessage.type !== "user_message" || admission.run.executionCapability !== "repository") throw unavailable();
  const configuration = LocalTurnConfigurationSchema.parse(admission.userMessage.content.configuration);
  if (artifactCapture !== (configuration.mode === "build" ? "required" : "omitted_read_only")) throw unavailable();
  const current = await persistence.turnAdmissions.getByTurn(admission.turn.id);
  if (!current || !isDeepStrictEqual(TurnAdmissionSchema.parse(current), admission)) throw unavailable();
  const publication = await readLocalTurnArtifactPublication(persistence.lifecycleEvents, admission);
  if (!publication.terminal || (artifactCapture === "required" &&
      publication.terminal.type === "turn.completed" && !publication.diff) ||
      (artifactCapture === "omitted_read_only" && publication.diff)) throw unavailable();
  const scope = scopeOf(admission);
  const artifacts: LocalNativeResourceSettlement["artifacts"] = [];
  if (publication.diff) {
    const store = persistence.turnArtifacts.forAttempt(scope);
    const start = await store.getSnapshot("start");
    const terminal = await store.getSnapshot("terminal");
    const diff = await store.getTurnDiff();
    if (!start || !terminal || !diff || !isDeepStrictEqual(diff.diff, publication.diff) ||
        !isDeepStrictEqual(start.snapshot, diff.diff.startSnapshot) ||
        !isDeepStrictEqual(terminal.snapshot, diff.diff.terminalSnapshot)) throw unavailable();
    for (const [role, saved] of [["start", start], ["terminal", terminal], ["diff", diff]] as const) {
      const sha256 = saved.artifact.payloadRef.sha256;
      if (typeof sha256 !== "string") throw unavailable();
      artifacts.push({ role, artifactId: saved.artifact.artifactId, sha256 });
    }
  }
  return {
    scope, admissionSha256: fingerprint(admission),
    terminal: { eventId: publication.terminal.eventId, sequence: publication.terminal.sequence,
      sha256: fingerprint(publication.terminal), status: publication.terminal.payload.outcome.status },
    artifactCapture, artifacts,
  };
}

function scopeOf(admission: TurnAdmission) {
  return {
    userId: admission.run.userId, workspaceId: admission.run.workspaceId,
    threadId: admission.run.threadId, runId: admission.run.id,
    turnId: admission.turn.id, runAttemptId: admission.runAttemptId,
  };
}
function fingerprint(value: unknown): string {
  return createHash("sha256").update(createStableEventFingerprint(value)).digest("hex");
}
function unavailable(): AppServerOperationError {
  return new AppServerOperationError(503, "server_unavailable", "Native predecessor resource settlement requires recovery", "native_predecessor_recovery_required", false);
}
