import { createHash } from "node:crypto";
import {
  HarnessCommitAckSchema,
  HarnessObservationSchema,
  HarnessQuiescenceSchema,
  type HarnessCommitAck,
  type HarnessObservation,
  type HarnessQuiescence,
  type HarnessSession,
  type HarnessStartCommand,
} from "@repo/worker-protocol";
import type { HarnessHost } from "./HarnessHost.js";
import { ObservationDeliveryJournal } from "./ObservationDeliveryJournal.js";
import { HarnessHostError } from "./errors.js";
export interface HarnessRecoveryInput {
  readonly command: HarnessStartCommand;
  /** Prepared protected journal location, resolved by the existing binding/lease owner. */
  readonly host: HarnessHost;
  readonly timeoutMs: number;
  readonly observe: (
    observation: HarnessObservation,
  ) => Promise<HarnessCommitAck>;
  /** Canonical owner durably fences old commands/replies and proves the full old execution boundary stopped. */
  readonly fenceAndQuiesce: (input: {
    readonly command: HarnessStartCommand;
    readonly session: HarnessSession;
    readonly journalDirectory: string;
    readonly signal: AbortSignal;
  }) => Promise<HarnessQuiescence>;
}
interface LiveWriter {
  beforeReplay(): Promise<void>;
  acknowledge(sequence: number): Promise<void>;
  finish(): Promise<void>;
}

/** Host-side ordering only. Canonical owners provide the durable fence and append transaction. */
export class HarnessRecovery {
  private readonly jobs = new Map<string, Promise<HarnessQuiescence>>();
  reconcile(
    input: HarnessRecoveryInput,
    session: HarnessSession,
    live: LiveWriter,
  ): Promise<HarnessQuiescence> {
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          session,
          input.command.selection,
          input.host.journalDirectory,
        ]),
      )
      .digest("hex");
    const prior = this.jobs.get(key);
    if (prior) return prior;
    if (this.jobs.size >= 128) throw new HarnessHostError("session_busy");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = Promise.resolve().then(
      async (): Promise<HarnessQuiescence> => {
        const evidence = HarnessQuiescenceSchema.parse(
          await input.fenceAndQuiesce({
            command: input.command,
            session,
            journalDirectory: input.host.journalDirectory,
            signal: controller.signal,
          }),
        );
        controller.signal.throwIfAborted();
        assertSession(session, evidence.session);
        if (evidence.status !== "quiescent") return evidence;
        await live.beforeReplay();
        controller.signal.throwIfAborted();
        const frames = await ObservationDeliveryJournal.readPending({
          directory: input.host.journalDirectory,
          streamKey: JSON.stringify(session),
          maxBytes: 8 * 1024 * 1024,
          maxFrames: 256,
          codec: {
            parse: (value: unknown) => {
              const observation = HarnessObservationSchema.parse(value);
              assertSession(session, observation.session);
              return observation;
            },
            sequence: (observation: HarnessObservation) => observation.sequence,
          },
        });
        for (const observation of frames) {
          controller.signal.throwIfAborted();
          const ack = HarnessCommitAckSchema.parse(
            await input.observe(observation),
          );
          controller.signal.throwIfAborted();
          assertSession(session, ack.session);
          if (ack.committedSequence !== observation.sequence)
            throw new HarnessHostError("journal_corrupt");
          await live.acknowledge(ack.committedSequence);
        }
        await live.finish();
        return evidence;
      },
    );
    const result = Promise.race([
      work,
      new Promise<HarnessQuiescence>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve({ status: "unknown", session, reason: "timeout" });
        }, input.timeoutMs);
      }),
    ])
      .catch((error: unknown): HarnessQuiescence => {
        if (error instanceof HarnessHostError) throw error;
        return { status: "unknown", session, reason: "transport_lost" };
      })
      .finally(() => {
        if (timer) clearTimeout(timer);
      });
    this.jobs.set(key, result);
    // Do not begin another reconciliation while a timed-out callback is still running.
    void work.then(
      (evidence) => {
        if (evidence.status !== "quiescent" || controller.signal.aborted)
          this.jobs.delete(key);
      },
      () => {
        this.jobs.delete(key);
      },
    );
    return result;
  }
}
function assertSession(a: HarnessSession, b: HarnessSession): void {
  if (
    a.runAttemptId !== b.runAttemptId ||
    a.instanceId !== b.instanceId ||
    a.externalSessionId !== b.externalSessionId ||
    a.processGeneration !== b.processGeneration
  )
    throw new HarnessHostError("stale_session");
}
