import type { HarnessCommitAck, HarnessControlCommand, HarnessObservation, HarnessQuiescence, HarnessSession, HarnessStartCommand } from "@repo/worker-protocol";

/** Placement-independent execution. Concrete Node SDK types stay in the driver. */
export interface DelegatedHarnessPort {
  /** Open/resume is identity establishment only; prompt delivery occurs in execute. */
  open(input: { readonly command: HarnessStartCommand; readonly signal: AbortSignal }): Promise<HarnessSession>;
  /** Host journals before delivery; observe resolves only after the canonical commit. */
  execute(input: {
    readonly command: HarnessStartCommand;
    readonly session: HarnessSession;
    readonly signal: AbortSignal;
    readonly observe: (observation: HarnessObservation) => Promise<HarnessCommitAck>;
  }): Promise<void>;
  /** Acceptance is not terminal settlement or quiescence. Never automatically resend. */
  control(command: HarnessControlCommand): Promise<{ readonly accepted: boolean }>;
  awaitQuiescence(input: { readonly session: HarnessSession; readonly timeoutMs: number }): Promise<HarnessQuiescence>;
}

/** P11 implementation must atomically deduplicate ingress and append canonical events.
 * The callback runs only for a new, next sequence inside the same transaction.
 * Existing committed ingress returns its prior ACK without invoking append again.
 */
export interface HarnessObservationCommitPort {
  commit(input: {
    readonly observation: HarnessObservation;
    readonly append: () => Promise<void>;
  }): Promise<HarnessCommitAck>;
}
