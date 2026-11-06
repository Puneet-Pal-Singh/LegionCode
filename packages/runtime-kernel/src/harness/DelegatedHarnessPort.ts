import type { LifecycleEvent } from "@repo/platform-protocol";
import type {
  HarnessCommitAck,
  HarnessControlCommand,
  HarnessObservation,
  HarnessQuiescence,
  HarnessSession,
  HarnessStartCommand,
} from "@repo/worker-protocol";

/** Placement-independent execution. Concrete Node SDK types stay in the driver. */
export interface DelegatedHarnessPort {
  /** Open/resume is identity establishment only; prompt delivery occurs in execute. */
  open(input: {
    readonly command: HarnessStartCommand;
    readonly signal: AbortSignal;
  }): Promise<HarnessSession>;
  /** Host journals before delivery; observe resolves only after the canonical commit. */
  execute(input: {
    readonly command: HarnessStartCommand;
    readonly session: HarnessSession;
    readonly signal: AbortSignal;
    readonly observe: (
      observation: HarnessObservation,
    ) => Promise<HarnessCommitAck>;
  }): Promise<void>;
  /** Reattach/replay only. This operation has no prompt/steer/reply argument and
   * must never cause an ambiguous external command to be sent again. */
  observeExisting(input: {
    readonly session: HarnessSession;
    readonly signal: AbortSignal;
    readonly observe: (
      observation: HarnessObservation,
    ) => Promise<HarnessCommitAck>;
  }): Promise<void>;
  /** Acceptance is not terminal settlement or quiescence. Never automatically resend. */
  control(
    command: HarnessControlCommand,
  ): Promise<{ readonly accepted: boolean }>;
  awaitQuiescence(input: {
    readonly session: HarnessSession;
    readonly timeoutMs: number;
  }): Promise<HarnessQuiescence>;
}

/** P11 owns the durable transaction: validate active binding, deduplicate the exact
 * ingress identity, append events and ingress atomically, then publish continuation.
 * No ACK is returned on an ambiguous/failed commit. Duplicate payload conflicts reject.
 */
export interface HarnessObservationRecovery {
  readonly session: HarnessSession;
  readonly lifecycleEvents: readonly LifecycleEvent[];
  readonly lastSequence: number;
  readonly externalTurnId: string | null;
  readonly terminal: Extract<
    HarnessObservation["payload"],
    { kind: "external_terminal" }
  > | null;
  readonly quiescence: HarnessQuiescence | null;
  /** Only requests still pending in canonical replay; consumed/ambiguous replies
   * must not be made actionable again by the persistence adapter. */
  readonly pendingRequests: readonly Extract<
    HarnessObservation["payload"],
    { kind: "approval_requested" | "user_input_requested" }
  >[];
}

export interface HarnessObservationCommitPort {
  /** Existing canonical replay plus compact, validated binding/ingress facts.
   * This is not a second transcript or a host-journal history API. */
  recover(session: HarnessSession): Promise<HarnessObservationRecovery>;
  /** Durable single-use claim before delivery. An ambiguous send stays consumed. */
  claimReply(
    origin: import("@repo/worker-protocol").HarnessRequestOrigin,
  ): Promise<"claimed" | "already_consumed">;
  lookup(observation: HarnessObservation): Promise<HarnessCommitAck | null>;
  commit(input: {
    readonly observation: HarnessObservation;
    readonly events: readonly LifecycleEvent[];
  }): Promise<HarnessCommitAck>;
}
