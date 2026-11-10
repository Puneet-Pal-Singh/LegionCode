import {
  JsonRecordSchema,
  LifecycleEventSchema,
  TurnWorkspaceSnapshotSchema,
  type TurnWorkspaceSnapshot,
} from "@repo/platform-protocol";
import type { HarnessSession } from "@repo/worker-protocol";
import type {
  HarnessObservationCommitPort,
  HarnessObservationRecovery,
} from "./DelegatedHarnessPort.js";
import { sameHarnessSession } from "./HarnessObservationIngestor.js";
import { RuntimeKernelError } from "../errors.js";

/** Read/validate existing authorities before any recovery start/capture side effect. */
export async function bootstrapDelegatedRecovery(input: {
  readonly persistence: HarnessObservationCommitPort;
  readonly session: HarnessSession;
  readonly turnId: import("@repo/platform-protocol").TurnId;
  readonly minimumSequence: number;
}): Promise<{
  recovery: HarnessObservationRecovery;
  start: { snapshot: TurnWorkspaceSnapshot; artifact: unknown };
}> {
  const recovery = await input.persistence.recover(input.session);
  if (!sameHarnessSession(recovery.session, input.session))
    throw new RuntimeKernelError(
      "invalid_turn_identity",
      "Recovery session does not match durable binding",
    );
  const events = recovery.lifecycleEvents.map((event) =>
    LifecycleEventSchema.parse(event),
  );
  if (
    events.length === 0 ||
    (events.at(-1)?.sequence ?? 0) < input.minimumSequence ||
    events.some(
      (event) =>
        event.turnId !== input.turnId ||
        event.runAttemptId !== input.session.runAttemptId,
    )
  ) {
    throw new RuntimeKernelError(
      "invalid_turn_identity",
      "Recovery requires the complete canonical same-attempt history",
    );
  }
  for (const event of events) {
    if (event.type !== "workspace.snapshot_captured") continue;
    const wrapper = JsonRecordSchema.parse(event.payload.snapshot);
    const snapshot = TurnWorkspaceSnapshotSchema.parse(wrapper.snapshot);
    if (snapshot.phase === "start" && snapshot.turnId === input.turnId) {
      return {
        recovery: { ...recovery, lifecycleEvents: events },
        start: { snapshot, artifact: JsonRecordSchema.parse(wrapper.artifact) },
      };
    }
  }
  throw new RuntimeKernelError(
    "turn_artifact_settlement_failed",
    "Same-attempt recovery has no committed immutable start snapshot",
  );
}
