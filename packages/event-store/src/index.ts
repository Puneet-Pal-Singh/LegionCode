export {
  EVENT_STORE_ERROR_CODES,
  EventStoreError,
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

export {
  HarnessPersistenceError,
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
