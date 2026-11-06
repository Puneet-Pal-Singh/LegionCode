import type {
  HarnessCommitAck,
  HarnessControlCommand,
  HarnessObservation,
  HarnessQuiescence,
  HarnessSession,
  HarnessStartCommand,
} from "@repo/worker-protocol";
import type { HarnessKind } from "../client.js";
import type { HarnessHost } from "./HarnessHost.js";

/** Native SDK/RPC types never cross this interface. */
export interface HarnessDriver {
  readonly kind: HarnessKind;
  /** Establish identity only. Never start or auto-resume provider work during open. */
  open(input: {
    readonly command: HarnessStartCommand;
    readonly host: HarnessHost;
    readonly signal: AbortSignal;
    readonly observe: (
      observation: Omit<HarnessObservation, "sequence">,
    ) => Promise<HarnessCommitAck>;
  }): Promise<HarnessLiveSession>;
}

export interface HarnessLiveSession {
  readonly session: HarnessSession;
  execute(input: {
    readonly command: HarnessStartCommand;
    readonly signal: AbortSignal;
  }): Promise<void>;
  /** Reattach/replay only; must never send provider start, steer or reply effects. */
  observeExisting(input: { readonly signal: AbortSignal }): Promise<void>;
  /** Receipt means acceptance only. A lost response is not permission to retry. */
  control(
    command: HarnessControlCommand,
  ): Promise<{ readonly accepted: boolean }>;
  /** Must include child/background work under the actual enforced execution boundary. */
  awaitQuiescence(input: {
    readonly timeoutMs: number;
  }): Promise<HarnessQuiescence>;
}
