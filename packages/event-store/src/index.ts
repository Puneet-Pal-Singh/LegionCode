export {
  EVENT_STORE_ERROR_CODES,
  EventStoreError,
  LifecycleReplayEventTooLargeError,
  LocalPersistenceError,
  type EventStoreErrorCode,
} from "./errors.js";
export { MemoryEventStore } from "./MemoryEventStore.js";
export { MemoryLifecycleEventStore } from "./MemoryLifecycleEventStore.js";
export { createStableEventFingerprint } from "./fingerprint.js";
export {
  type AppendEventInput,
  type EventStore,
  type EventStoreClock,
  type EventStoreIdGenerator,
  type ReplayEventsInput,
  type ReplayEventsResult,
} from "./types.js";
export type {
  LifecycleEventStore,
  ReplayLifecycleEventsInput,
  ReplayLifecycleEventsResult,
} from "./lifecycle-types.js";

export { ThreadInputConflictError } from "./thread-inputs/errors.js";
export type {
  ThreadInputScope,
  StoredThreadInput,
  CreateThreadInput,
  UpdateThreadInput,
  ClaimQueuedInputForSteering,
  ThreadInputMutation,
  ThreadInputRepository,
} from "./thread-inputs/types.js";
export {
  HarnessPersistenceError,
  StoredHarnessOpeningSchema,
  assertHarnessOpeningSelection,
  assertHarnessOpeningIntent,
  assertHarnessOpeningOrigin,
  validateHarnessOpeningCommand,
  validateHarnessOpeningHistory,
  StoredHarnessSelectionSchema,
  StoredHarnessAttachmentSchema,
  harnessSelectionFingerprint,
  assertHarnessSelection,
  assertHarnessOrigin,
  assertHarnessAttachmentChange,
  validateHarnessObservation,
  assertEventScope,
  assertLearnedExternalTurn,
  sameHarnessOrigin,
  fingerprintHarnessObservation,
} from "./local/harness-bindings.js";
export type {
  StoredHarnessOpening,
  ReserveHarnessOpeningInput,
  HarnessOpeningInput,
  HarnessOpeningReservation,
  StoredHarnessSelection,
  StoredHarnessAttachment,
  StoredHarnessBinding,
  HarnessObservationCommit,
  HarnessObservationAck,
  HarnessBindingRepository,
  HarnessExecutionClaimResult,
} from "./local/harness-bindings.js";

export { LocalHarnessObservationCommitPort } from "./local/harness-observation-port.js";

export { rethrowHarnessCommitFailure } from "./local/harness-bindings.js";

export {
  LocalHarnessControlPlane,
  LocalHarnessControlPlaneError,
} from "./local/harness-control-plane.js";
export type { LocalHarnessControlPlanePort } from "./local/harness-control-plane.js";
