// These are storage envelopes; P04 owns canonical harness selection/observation
// schemas. Persist their validated selection JSON without redefining that model.
export type {
  StoredHarnessSelection,
  StoredHarnessAttachment,
  StoredHarnessBinding,
  HarnessObservationCommit,
  HarnessObservationAck,
  HarnessBindingRepository,
  HarnessExecutionClaimResult,
} from "@repo/event-store";
