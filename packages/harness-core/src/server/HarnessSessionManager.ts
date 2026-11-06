import {
  HarnessCommitAckSchema,
  HarnessControlCommandSchema,
  HarnessObservationSchema,
  HarnessQuiescenceSchema,
  HarnessSessionSchema,
  HarnessStartCommandSchema,
  type HarnessCommitAck,
  type HarnessControlCommand,
  type HarnessObservation,
  type HarnessQuiescence,
  type HarnessSession,
  type HarnessStartCommand,
} from "@repo/worker-protocol";
import type { HarnessLiveSession } from "./HarnessDriver.js";
import type { ProcessGroupSettlement } from "./ProcessSupervisor.js";
import type { HarnessHost } from "./HarnessHost.js";
import { HarnessRegistry } from "./HarnessRegistry.js";
import { ObservationDeliveryJournal } from "./ObservationDeliveryJournal.js";
import { HarnessHostError } from "./errors.js";

type Observe = (observation: HarnessObservation) => Promise<HarnessCommitAck>;

export type { HarnessRecoveryInput } from "./HarnessRecovery.js";
import {
  HarnessRecovery,
  type HarnessRecoveryInput,
} from "./HarnessRecovery.js";

interface Attachment {
  readonly command: HarnessStartCommand;
  readonly fingerprint: string;
  readonly controller: AbortController;
  readonly requests: Map<
    string,
    {
      committed: Promise<void>;
      consume: boolean;
      kind: HarnessObservation["payload"]["kind"];
    }
  >;
  opening?: Promise<HarnessSession>;
  host?: HarnessHost;
  live?: HarnessLiveSession;
  session?: HarnessSession;
  journal?: ObservationDeliveryJournal<HarnessObservation>;
  observe?: Observe;
  execution?: Promise<void>;
  observing?: Promise<void>;
  stopping: boolean;
  retired: boolean;
  cleanup?: Promise<readonly ProcessGroupSettlement[]>;
  readonly controls: Map<
    string,
    {
      readonly fingerprint: string;
      readonly result: Promise<{ readonly accepted: boolean }>;
    }
  >;
  observationQueue: Promise<unknown>;
  pendingObservations: number;
  externalTurnId: string | null;
  integrityError?: HarnessHostError;
  integrityPersistence?: Promise<void>;
  quiescence?: Extract<HarnessQuiescence, { status: "quiescent" }> & {
    observationIntegrity: "complete";
  };
}

/** Live attachments only. Admission, recovery decisions, canonical history and leases remain runtime-owned. */
export class HarnessSessionManager {
  private readonly attachments = new Map<string, Attachment>();
  private readonly instanceDirectories = new Set<string>();
  private readonly journalDirectories = new Set<string>();
  private readonly recovery = new HarnessRecovery();

  constructor(private readonly registry: HarnessRegistry) {}

  open(input: {
    readonly command: HarnessStartCommand;
    readonly signal: AbortSignal;
  }): Promise<HarnessSession> {
    const { command, instance } = this.registry.resolve(input.command);
    if (command.mode !== "start")
      return Promise.reject(new HarnessHostError("stale_session"));
    const signal = input.signal;
    const fingerprint = JSON.stringify(command);
    const key = command.selection.runAttemptId;
    const existing = this.attachments.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint || !existing.opening)
        return Promise.reject(new HarnessHostError("session_busy"));
      return existing.opening;
    }
    if (this.attachments.size >= 128)
      return Promise.reject(new HarnessHostError("session_busy"));
    const attachment: Attachment = {
      command,
      fingerprint,
      controller: new AbortController(),
      requests: new Map(),
      stopping: false,
      retired: false,
      controls: new Map(),
      observationQueue: Promise.resolve(),
      pendingObservations: 0,
      externalTurnId: null,
    };
    // Register before async host creation or any driver/provider I/O so immediate Stop cannot miss it.
    this.attachments.set(key, attachment);
    const abort = () => this.beginStop(attachment);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    attachment.opening = (async () => {
      try {
        if (attachment.stopping) throw new HarnessHostError("stale_session");
        const host = await instance.createHost(command);
        attachment.host = host;
        if (attachment.stopping) {
          this.beginStop(attachment);
          throw new HarnessHostError("stale_session");
        }
        if (
          this.instanceDirectories.has(host.instanceDirectory) ||
          this.journalDirectories.has(host.journalDirectory)
        )
          throw new HarnessHostError("session_busy");
        this.instanceDirectories.add(host.instanceDirectory);
        this.journalDirectories.add(host.journalDirectory);
        const live = await instance.driver.open({
          command,
          host,
          signal: attachment.controller.signal,
          observe: (observation) => this.observe(attachment, observation),
        });
        const session = HarnessSessionSchema.parse(live.session);
        if (
          session.runAttemptId !== key ||
          session.instanceId !== command.selection.instanceId ||
          !Object.is(session.processGeneration, host.processGeneration)
        ) {
          throw new HarnessHostError("stale_session");
        }
        attachment.live = live;
        attachment.session = session;
        const directory = host.journalDirectory;
        attachment.journal = await this.openJournal(directory, session);
        this.assertIntegrity(attachment);
        if (attachment.stopping) {
          this.beginStop(attachment);
          throw new HarnessHostError("stale_session");
        }
        return session;
      } catch (error) {
        this.beginStop(attachment);
        // Retain the failed attempt. Repeating an ambiguous open must not launch another process/store.
        throw error instanceof HarnessHostError
          ? error
          : new HarnessHostError("stale_session");
      }
    })();
    void attachment.opening.catch(() => undefined);
    return attachment.opening;
  }

  /** Reconcile before open/rebind. Never resumes provider work or steals a dead writer lock. */
  reconcilePriorGeneration(
    input: HarnessRecoveryInput,
  ): Promise<HarnessQuiescence> {
    const command = HarnessStartCommandSchema.parse(input.command);
    const session = command.resumeSession;
    if (
      !session ||
      session.instanceId !== command.selection.instanceId ||
      Object.is(session.processGeneration, input.host.processGeneration)
    )
      throw new HarnessHostError("stale_session");
    if (
      !Number.isSafeInteger(input.timeoutMs) ||
      input.timeoutMs < 1 ||
      input.timeoutMs > 60_000
    )
      throw new HarnessHostError("invalid_launch");
    const old = this.attachments.get(session.runAttemptId);
    if (old) {
      if (old.session) assertSession(session, old.session);
      if (old.host && old.host.journalDirectory !== input.host.journalDirectory)
        throw new HarnessHostError("stale_session");
      this.beginStop(old);
    }
    return this.recovery.reconcile({ ...input, command }, session, {
      assertIntegrity: () => {
        if (old) this.assertIntegrity(old);
      },
      beforeReplay: async () => {
        if (old) {
          if (this.attachments.get(session.runAttemptId) !== old)
            throw new HarnessHostError("stale_session");
          old.retired = true;
          await old.observationQueue;
        }
      },
      acknowledge: async (sequence) => {
        await old?.journal?.acknowledge(sequence);
      },
      finish: async (canonicalFailureSettled) => {
        if (!old) return;
        if (!canonicalFailureSettled) this.assertIntegrity(old);
        await old.journal?.close();
        if (this.attachments.get(session.runAttemptId) !== old)
          throw new HarnessHostError("stale_session");
        this.attachments.delete(session.runAttemptId);
        if (old.host) {
          this.instanceDirectories.delete(old.host.instanceDirectory);
          this.journalDirectories.delete(old.host.journalDirectory);
        }
      },
    });
  }

  execute(input: {
    readonly command: HarnessStartCommand;
    readonly session: HarnessSession;
    readonly signal: AbortSignal;
    readonly observe: Observe;
  }): Promise<void> {
    const attachment = this.requireSession(input.session);
    const { command } = this.registry.resolve(input.command);
    if (command.mode !== "start")
      return Promise.reject(new HarnessHostError("stale_session"));
    if (attachment.fingerprint !== JSON.stringify(command))
      return Promise.reject(new HarnessHostError("stale_session"));
    this.assertIntegrity(attachment);
    if (attachment.execution) return attachment.execution;
    if (
      attachment.stopping ||
      input.signal.aborted ||
      !attachment.live ||
      !attachment.journal
    )
      return Promise.reject(new HarnessHostError("stale_session"));
    attachment.observe = input.observe;
    const abort = () => this.beginStop(attachment);
    input.signal.addEventListener("abort", abort, { once: true });
    attachment.execution = (async () => {
      try {
        // Only observations replay. Provider start/steer/reply operations are never replayed here.
        await this.replayPending(attachment);
        if (attachment.stopping) throw new HarnessHostError("stale_session");
        await attachment.live!.execute({
          command,
          signal: attachment.controller.signal,
        });
        await this.drainObservations(attachment);
      } finally {
        input.signal.removeEventListener("abort", abort);
      }
    })();
    void attachment.execution.catch(() => undefined);
    return attachment.execution;
  }

  observeExisting(input: {
    readonly session: HarnessSession;
    readonly signal: AbortSignal;
    readonly observe: Observe;
  }): Promise<void> {
    const attachment = this.requireSession(input.session);
    if (
      attachment.retired ||
      input.signal.aborted ||
      !attachment.live ||
      !attachment.journal
    )
      return Promise.reject(new HarnessHostError("stale_session"));
    this.assertIntegrity(attachment);
    attachment.observe = input.observe;
    if (attachment.observing) return attachment.observing;
    const abort = () => this.beginStop(attachment);
    input.signal.addEventListener("abort", abort, { once: true });
    const replay = attachment.observationQueue.then(() =>
      this.replayPending(attachment),
    );
    attachment.observationQueue = replay.catch(() => undefined);
    attachment.observing = (async () => {
      try {
        await replay;
        input.signal.throwIfAborted();
        // This native method has no prompt, steer or reply argument. It may only observe/reconcile.
        await attachment.live!.observeExisting({
          signal: attachment.controller.signal,
        });
        await this.drainObservations(attachment);
      } catch (error) {
        this.beginStop(attachment);
        throw error instanceof HarnessHostError
          ? error
          : new HarnessHostError("stale_session");
      } finally {
        input.signal.removeEventListener("abort", abort);
      }
    })();
    void attachment.observing.catch(() => undefined);
    return attachment.observing;
  }

  control(raw: HarnessControlCommand): Promise<{ readonly accepted: boolean }> {
    const command = HarnessControlCommandSchema.parse(raw);
    const session =
      command.kind === "reply" || command.kind === "user_input_reply"
        ? command.reply.replyTo.session
        : command.session;
    const attachment = this.requireSession(session);
    const fingerprint = JSON.stringify(command);
    const prior = attachment.controls.get(command.commandId);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        return Promise.reject(new HarnessHostError("stale_session"));
      return prior.result;
    }
    if (attachment.controls.size >= 128) {
      this.beginStop(attachment);
      return Promise.reject(new HarnessHostError("session_busy"));
    }
    const result = Promise.resolve().then(() =>
      this.applyControl(attachment, command),
    );
    attachment.controls.set(command.commandId, { fingerprint, result });
    void result.catch(() => undefined);
    return result;
  }

  private async applyControl(
    attachment: Attachment,
    command: HarnessControlCommand,
  ): Promise<{ readonly accepted: boolean }> {
    if (!attachment.live) throw new HarnessHostError("stale_session");
    if (command.kind === "reply" || command.kind === "user_input_reply") {
      const origin = command.reply.replyTo;
      if (
        attachment.stopping ||
        origin.authOwnerGeneration !==
          attachment.command.selection.authOwnerGeneration
      )
        throw new HarnessHostError("request_unavailable");
      const request = attachment.requests.get(requestKey(origin));
      if (
        !request ||
        request.consume ||
        (command.kind === "reply"
          ? request.kind !== "approval_requested"
          : request.kind !== "user_input_requested")
      )
        throw new HarnessHostError("request_unavailable");
      await request.committed;
      // A Stop, revoke, or competing reply can win while the commit ACK is in flight.
      if (attachment.stopping || request.consume)
        throw new HarnessHostError("request_unavailable");
      request.consume = true;
      return attachment.live.control(command);
    }
    if (
      command.kind === "steer" &&
      (attachment.stopping ||
        !attachment.execution ||
        attachment.externalTurnId !== command.expectedExternalTurnId)
    )
      throw new HarnessHostError("stale_session");
    if (command.kind === "interrupt" || command.kind === "dispose") {
      attachment.stopping = true;
      attachment.host?.fence();
      // Host acceptance is separate from the provider receipt and quiescence.
      // A hung provider RPC cannot block the bounded host cleanup.
      try {
        const nativeReceipt = attachment.live.control(command);
        void nativeReceipt.catch(() => undefined); // The driver reports transport loss; never resend.
      } finally {
        this.beginStop(attachment);
      }
      return { accepted: true };
    }
    return attachment.live.control(command);
  }

  async awaitQuiescence(input: {
    readonly session: HarnessSession;
    readonly timeoutMs: number;
  }): Promise<HarnessQuiescence> {
    const attachment = this.requireSession(input.session);
    attachment.quiescence = undefined;
    if (
      !Number.isSafeInteger(input.timeoutMs) ||
      input.timeoutMs < 0 ||
      input.timeoutMs > 60_000
    )
      throw new HarnessHostError("invalid_launch");
    if (this.hasIntegrityLoss(attachment))
      return {
        status: "unknown",
        session: input.session,
        reason: "observation_integrity_lost",
      };
    if (!attachment.live)
      return {
        status: "unknown",
        session: input.session,
        reason: "transport_lost",
      };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        attachment.live.awaitQuiescence({ timeoutMs: input.timeoutMs }),
        new Promise<HarnessQuiescence>((resolve) => {
          timer = setTimeout(
            () =>
              resolve({
                status: "unknown",
                session: input.session,
                reason: "timeout",
              }),
            input.timeoutMs,
          );
        }),
      ]);
      if (
        attachment.pendingObservations > 0 ||
        this.hasIntegrityLoss(attachment) ||
        attachment.retired
      )
        return {
          status: "unknown",
          session: input.session,
          reason: this.hasIntegrityLoss(attachment)
            ? "observation_integrity_lost"
            : "work_still_running",
        };
      const evidence = HarnessQuiescenceSchema.parse(result);
      assertSession(input.session, evidence.session);
      // Drivers/composition must prove the full execution boundary; group exit is never promoted here.
      if (
        (evidence.status === "quiescent" &&
          evidence.observationIntegrity === "lost") ||
        (evidence.status === "unknown" &&
          evidence.reason === "observation_integrity_lost")
      ) {
        void this.loseIntegrity(
          attachment,
          new HarnessHostError("observation_integrity_lost"),
        ).catch(() => undefined);
      }
      if (
        evidence.status === "quiescent" &&
        evidence.observationIntegrity === "complete"
      )
        attachment.quiescence = {
          ...evidence,
          observationIntegrity: evidence.observationIntegrity,
        };
      return evidence;
    } catch {
      return {
        status: "unknown",
        session: input.session,
        reason: this.hasIntegrityLoss(attachment)
          ? "observation_integrity_lost"
          : "transport_lost",
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Canonical owner calls only after terminal artifact settlement; no checkout lease is released here. */
  async release(session: HarnessSession): Promise<void> {
    const attachment = this.requireSession(session);
    if (
      !attachment.quiescence ||
      attachment.quiescence.observationIntegrity !== "complete"
    )
      throw new HarnessHostError("process_not_quiescent");
    this.beginStop(attachment);
    await this.drainObservations(attachment);
    await attachment.cleanup;
    const cleanup = await attachment.host?.terminateProcesses({
      graceMs: 1000,
      killWaitMs: 1000,
    });
    if (!cleanup || cleanup.some((result) => result.kind === "unknown"))
      throw new HarnessHostError("process_not_quiescent");
    await attachment.observationQueue;
    this.assertIntegrity(attachment);
    if (attachment.journal) {
      if ((await attachment.journal.pending()).length)
        throw new HarnessHostError("journal_corrupt");
      if (
        !attachment.quiescence ||
        attachment.quiescence.observationIntegrity !== "complete"
      )
        throw new HarnessHostError("process_not_quiescent");
      attachment.retired = true;
      await attachment.journal.markCanonicalSettlement();
      await attachment.journal.close();
    }
    // Keep journal files for commit reconciliation. They contain no command replay.
    this.attachments.delete(session.runAttemptId);
    if (attachment.host) {
      this.instanceDirectories.delete(attachment.host.instanceDirectory);
      this.journalDirectories.delete(attachment.host.journalDirectory);
    }
  }

  /** Connection revocation prevents both late replies and new instance admissions synchronously. */
  fenceInstance(instanceId: string): void {
    this.registry.unregister(instanceId);
    for (const attachment of this.attachments.values()) {
      if (attachment.command.selection.instanceId === instanceId)
        this.beginStop(attachment);
    }
  }

  private beginStop(attachment: Attachment): void {
    attachment.stopping = true;
    attachment.controller.abort();
    attachment.host?.fence();
    if (attachment.host && !attachment.cleanup) {
      attachment.cleanup = attachment.host.terminateProcesses({
        graceMs: 1000,
        killWaitMs: 1000,
      });
      void attachment.cleanup.catch(() => undefined);
    }
  }

  private requireSession(raw: HarnessSession): Attachment {
    const session = HarnessSessionSchema.parse(raw);
    const attachment = this.attachments.get(session.runAttemptId);
    if (!attachment?.live || !attachment.session)
      throw new HarnessHostError("stale_session");
    assertSession(session, attachment.session);
    return attachment;
  }

  private observe(
    attachment: Attachment,
    input: Omit<HarnessObservation, "sequence">,
  ): Promise<HarnessCommitAck> {
    if (attachment.retired)
      return Promise.reject(new HarnessHostError("stale_session"));
    attachment.quiescence = undefined;
    if (attachment.integrityError)
      return this.loseIntegrity(attachment, attachment.integrityError);
    if (attachment.pendingObservations >= 32) {
      return this.loseIntegrity(
        attachment,
        new HarnessHostError("journal_overflow"),
      );
    }
    let snapshot: HarnessObservation;
    try {
      const encoded = JSON.stringify({ ...input, sequence: 1 });
      if (Buffer.byteLength(encoded) > 8 * 1024 * 1024)
        throw new HarnessHostError("journal_overflow");
      snapshot = HarnessObservationSchema.parse(JSON.parse(encoded));
      if (
        snapshot.payload.kind === "quiescence" &&
        ((snapshot.payload.evidence.status === "quiescent" &&
          snapshot.payload.evidence.observationIntegrity === "lost") ||
          (snapshot.payload.evidence.status === "unknown" &&
            snapshot.payload.evidence.reason === "observation_integrity_lost"))
      ) {
        return this.loseIntegrity(
          attachment,
          new HarnessHostError("observation_integrity_lost"),
        );
      }
    } catch (error) {
      return this.loseIntegrity(attachment, error);
    }
    attachment.pendingObservations++;
    const result = attachment.observationQueue
      .then(() => this.observeNow(attachment, snapshot))
      .catch((error: unknown) => {
        return this.loseIntegrity(attachment, error);
      })
      .finally(() => {
        attachment.pendingObservations--;
      });
    attachment.observationQueue = result.catch(() => undefined);
    return result;
  }

  private async observeNow(
    attachment: Attachment,
    input: Omit<HarnessObservation, "sequence">,
  ): Promise<HarnessCommitAck> {
    this.assertIntegrity(attachment);
    if (
      !attachment.session ||
      !attachment.live ||
      !attachment.journal ||
      !attachment.observe
    )
      throw new HarnessHostError("stale_session");
    assertSession(attachment.session, input.session);
    if (input.externalTurnId !== null) {
      if (
        attachment.externalTurnId !== null &&
        attachment.externalTurnId !== input.externalTurnId
      )
        throw new HarnessHostError("stale_session");
      attachment.externalTurnId = input.externalTurnId;
    }
    const payload = input.payload;
    let committedResolve: (() => void) | undefined;
    let committedReject: ((error: unknown) => void) | undefined;
    if (
      payload.kind === "approval_requested" ||
      payload.kind === "user_input_requested"
    ) {
      assertSession(input.session, payload.replyTo.session);
      if (
        attachment.stopping ||
        payload.replyTo.authOwnerGeneration !==
          attachment.command.selection.authOwnerGeneration ||
        attachment.requests.has(requestKey(payload.replyTo)) ||
        attachment.requests.size >= 128
      )
        throw new HarnessHostError("request_unavailable");
      const committed = new Promise<void>((resolve, reject) => {
        committedResolve = resolve;
        committedReject = reject;
      });
      void committed.catch(() => undefined);
      attachment.requests.set(requestKey(payload.replyTo), {
        committed,
        consume: false,
        kind: payload.kind,
      });
    }
    try {
      const observation = await attachment.journal.append((sequence) =>
        HarnessObservationSchema.parse({ ...input, sequence }),
      );
      const ack = await this.deliver(attachment, observation);
      committedResolve?.();
      return ack;
    } catch (error) {
      committedReject?.(new HarnessHostError("request_unavailable"));
      return this.loseIntegrity(attachment, error);
    }
  }

  private async deliver(
    attachment: Attachment,
    observation: HarnessObservation,
  ): Promise<HarnessCommitAck> {
    try {
      this.assertIntegrity(attachment);
      if (!attachment.observe || !attachment.journal)
        throw new HarnessHostError("stale_session");
      const ack = HarnessCommitAckSchema.parse(
        await attachment.observe(observation),
      );
      this.assertIntegrity(attachment);
      assertSession(observation.session, ack.session);
      if (ack.committedSequence !== observation.sequence)
        throw new HarnessHostError("journal_corrupt");
      await attachment.journal.acknowledge(ack.committedSequence);
      return ack;
    } catch (error) {
      return this.loseIntegrity(attachment, error);
    }
  }

  private async replayPending(attachment: Attachment): Promise<void> {
    try {
      this.assertIntegrity(attachment);
      if (!attachment.journal) throw new HarnessHostError("journal_corrupt");
      for (const observation of await attachment.journal.pending())
        await this.deliver(attachment, observation);
    } catch (error) {
      await this.loseIntegrity(attachment, error);
    }
  }

  private hasIntegrityLoss(attachment: Attachment): boolean {
    try {
      this.assertIntegrity(attachment);
      return false;
    } catch {
      return true;
    }
  }

  private assertIntegrity(attachment: Attachment): void {
    if (attachment.integrityError) throw attachment.integrityError;
    attachment.journal?.assertIntegrity();
  }

  private async drainObservations(attachment: Attachment): Promise<void> {
    await attachment.observationQueue;
    await attachment.integrityPersistence;
    this.assertIntegrity(attachment);
  }

  private loseIntegrity(
    attachment: Attachment,
    _cause: unknown,
  ): Promise<never> {
    attachment.integrityError ??= new HarnessHostError(
      "observation_integrity_lost",
    );
    this.beginStop(attachment);
    if (!attachment.integrityPersistence) {
      const persistence =
        attachment.journal?.markIntegrityLost() ??
        Promise.reject(attachment.integrityError);
      attachment.integrityPersistence = persistence;
      void persistence.catch(() => {
        if (attachment.integrityPersistence === persistence)
          attachment.integrityPersistence = undefined;
      });
    }
    return attachment.integrityPersistence.then(
      () => {
        throw attachment.integrityError!;
      },
      () => {
        throw attachment.integrityError!;
      },
    );
  }

  private openJournal(
    directory: string,
    session: HarnessSession,
  ): Promise<ObservationDeliveryJournal<HarnessObservation>> {
    return ObservationDeliveryJournal.open(
      this.journalOptions(directory, session),
    );
  }

  private journalOptions(directory: string, session: HarnessSession) {
    return {
      directory,
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
    };
  }
}

function assertSession(expected: HarnessSession, actual: HarnessSession): void {
  const a = HarnessSessionSchema.parse(expected),
    b = HarnessSessionSchema.parse(actual);
  if (
    a.runAttemptId !== b.runAttemptId ||
    a.instanceId !== b.instanceId ||
    a.externalSessionId !== b.externalSessionId ||
    a.processGeneration !== b.processGeneration
  )
    throw new HarnessHostError("stale_session");
}
function requestKey(origin: {
  readonly origin: string;
  readonly requestId: string;
}): string {
  return JSON.stringify([origin.origin, origin.requestId]);
}
