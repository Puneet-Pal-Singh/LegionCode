import { captureNativePermissions } from "./OpenCodePermissionPolicy.js";
import { HarnessSelectionSchema } from "@repo/platform-protocol";
import { setTimeout as delay } from "node:timers/promises";
import { questionAnswer } from "./OpenCodeQuestionMapper.js";
import type { ModelRef, SessionCreateInput } from "@opencode/client";
import type {
  HarnessDriver,
  HarnessHost,
  HarnessLiveSession,
} from "@repo/harness-core/server";
import {
  HarnessControlCommandSchema,
  HarnessQuiescenceSchema,
  HarnessSessionSchema,
  HarnessStartCommandSchema,
  type HarnessQuiescence,
  type HarnessSession,
  type HarnessStartCommand,
} from "@repo/worker-protocol";
import { OpenCodeTransportError } from "./OpenCodeClient.js";
import {
  OpenCodePayerGuard,
  type OpenCodeSelectedPayerBinding,
} from "./OpenCodeAuthentication.js";
import { OpenCodeEventMapper } from "./OpenCodeEventMapper.js";
import {
  OPENCODE_TRANSPORT,
  requireOpenCodeVersion,
} from "./OpenCodeInstallation.js";
import { OpenCodeServerOwner } from "./OpenCodeServerOwner.js";
import { OpenCodeSession } from "./OpenCodeSession.js";

/** Concrete Node driver. Registry, journal, process enforcement and canonical lifecycle stay outside. */
export class OpenCodeV2Driver implements HarnessDriver {
  readonly kind = "opencode" as const;

  constructor(
    private readonly options: {
      readonly executable: string;
      /** Exact canonical compatibility tag from the pinned runtime manifest. */
      readonly protocolVersion: HarnessStartCommand["selection"]["protocolVersion"];
      /** Resolve only the admitted connection/model/policy through existing authorities. */
      readonly resolveConfiguration: (command: HarnessStartCommand) => Promise<{
        readonly model: ModelRef;
        readonly agent?: string;
        readonly priorThreadTokens: number;
        readonly payer: OpenCodeSelectedPayerBinding;
      }>;
      /** Existing policy authority resolves this exact frozen selection; never renderer/provider input. */
      readonly resolvePolicy: (command: HarnessStartCommand) => Promise<{
        readonly selection: HarnessStartCommand["selection"];
        readonly permissions: NonNullable<SessionCreateInput["permissions"]>;
      }>;
      /** Must attest actual enforced native configuration (including agent rules, saved grants and
       * permission hooks for all agents/descendants) plus the current canonical policy revision. No prompt-based attestation. */
      readonly assertEffectivePolicy: (input: {
        readonly command: HarnessStartCommand;
        readonly host: HarnessHost;
        readonly permissions: NonNullable<SessionCreateInput["permissions"]>;
        readonly externalSessionId: string | null;
      }) => Promise<void>;
      /** Real full-scope and ordered native stream/drain proof. Neither process-group exit nor
       * foreground completion can attest observationIntegrity. Return unknown if the barrier is unavailable. */
      readonly proveQuiescence: (input: {
        readonly host: HarnessHost;
        readonly session: HarnessSession;
        readonly timeoutMs: number;
        /** Completed work must finish naturally; cancellation cannot be relabeled completed. */
        readonly interrupted: boolean;
      }) => Promise<HarnessQuiescence>;
    },
  ) {
    if (
      typeof options.resolvePolicy !== "function" ||
      typeof options.assertEffectivePolicy !== "function"
    ) {
      throw new OpenCodeTransportError("policy authority unavailable", false);
    }
  }

  async open(
    input: Parameters<HarnessDriver["open"]>[0],
  ): Promise<HarnessLiveSession> {
    const command = HarnessStartCommandSchema.parse(input.command);
    const { host, signal, observe } = input;
    if (command.resumeSession !== null)
      throw new OpenCodeTransportError("resume capability unavailable", false);
    if (
      command.selection.harness !== this.kind ||
      command.selection.transport !== OPENCODE_TRANSPORT ||
      command.selection.protocolVersion !== this.options.protocolVersion ||
      command.filesystemRoot !== host.workspaceRoot ||
      command.startSnapshot.turnId !== command.selection.turnId ||
      command.startSnapshot.phase !== "start"
    ) {
      throw new OpenCodeTransportError("admission binding", false);
    }
    requireOpenCodeVersion(command.selection.runtimeVersion);
    signal.throwIfAborted();
    if (command.selection.billingSource !== "api_key")
      throw new OpenCodeTransportError(
        "selected payer route unavailable",
        false,
      );
    const { model, agent, priorThreadTokens, payer } = await this.options
      .resolveConfiguration(command)
      .catch(() => {
        throw new OpenCodeTransportError(
          "selected configuration unavailable",
          false,
        );
      });
    const configuration = Object.freeze({
      model: Object.freeze({ ...model }),
      agent,
      priorThreadTokens,
    });
    let payerGuard: OpenCodePayerGuard;
    try {
      payerGuard = new OpenCodePayerGuard(
        payer,
        command,
        host,
        configuration.model,
        configuration.agent,
        signal,
      );
    } catch {
      throw new OpenCodeTransportError(
        "selected payer binding unavailable",
        false,
      );
    }
    if (
      !Number.isSafeInteger(configuration.priorThreadTokens) ||
      configuration.priorThreadTokens < 0
    )
      throw new OpenCodeTransportError("canonical usage baseline", false);
    const policy = structuredClone(await this.options.resolvePolicy(command));
    if (
      JSON.stringify(HarnessSelectionSchema.parse(policy.selection)) !==
      JSON.stringify(command.selection)
    ) {
      throw new OpenCodeTransportError("frozen policy resolution", false);
    }
    const nativePermissions = captureNativePermissions(policy.permissions);
    // Mandatory actual-policy assertion before launch; the host's OS launch assertion is separate.
    await this.options.assertEffectivePolicy({
      command,
      host,
      permissions: nativePermissions,
      externalSessionId: null,
    });
    signal.throwIfAborted();
    const owner = await OpenCodeServerOwner.start({
      host: {
        ...host,
        launch: async (request) => {
          try {
            const beforeLaunch = await payerGuard.authorize(signal, null);
            beforeLaunch();
          } catch {
            throw new OpenCodeTransportError(
              "payer authorization before launch",
              false,
            );
          }
          return host.launch(request);
        },
      },
      executable: this.options.executable,
      signal,
    });
    let mapper: OpenCodeEventMapper | undefined;
    let native: OpenCodeSession | undefined;
    let executing = false;
    let execution: Promise<void> | undefined;
    let quiescenceJob: Promise<HarnessQuiescence> | undefined;
    let stopping = false;
    let terminalPublished = false;
    let provenQuiescence: HarnessQuiescence | undefined;
    let observationIntegrityLost = false;
    let observationIntegritySealed = false;
    let pendingObservations = 0;
    const deliver = async (observation: Parameters<typeof observe>[0]) => {
      pendingObservations++;
      try {
        return await observe(observation);
      } catch {
        observationIntegrityLost = true;
        observationIntegritySealed = false;
        provenQuiescence = undefined;
        throw new OpenCodeTransportError("observation commit ambiguous", true);
      } finally {
        pendingObservations--;
      }
    };
    let resolveForeground!: () => void;
    let rejectForeground!: (error: Error) => void;
    const foreground = new Promise<void>((resolve, reject) => {
      resolveForeground = resolve;
      rejectForeground = reject;
    });
    void foreground.catch(() => undefined);
    try {
      native = await OpenCodeSession.create(
        owner.transport,
        {
          model: configuration.model,
          permissions: nativePermissions,
          agent: configuration.agent,
          location: { directory: host.workspaceRoot },
        },
        async (event, withdrawal) => {
          if (observationIntegritySealed) {
            observationIntegrityLost = true;
            provenQuiescence = undefined;
            throw new OpenCodeTransportError(
              "observation after integrity barrier",
              true,
            );
          }
          if (!mapper || !native || !executing)
            throw new OpenCodeTransportError("work before execute", true);
          for (const payload of mapper.map(event, withdrawal)) {
            // HarnessSessionManager owns journal-before-send and validates the exact commit ACK.
            await deliver({
              session,
              externalTurnId: native.externalTurnId,
              payload,
            });
          }
          if (mapper.foregroundEnded) resolveForeground();
        },
        () => payerGuard.authorize(signal, null, owner.transport),
      );
      const session = HarnessSessionSchema.parse({
        runAttemptId: command.selection.runAttemptId,
        instanceId: command.selection.instanceId,
        externalSessionId: native.id,
        processGeneration: host.processGeneration,
      });
      mapper = new OpenCodeEventMapper({
        selection: command.selection,
        session,
        model: configuration.model,
        permissions: nativePermissions,
        priorThreadTokens: configuration.priorThreadTokens,
      });
      const capturedNative = native;
      const fenceFailure = (message: string) => {
        const error = new OpenCodeTransportError(message, true);
        if (!stopping && !observationIntegritySealed) {
          stopping = true;
          capturedNative.fence();
          host.fence();
          rejectForeground(error);
          void host
            .terminateProcesses({ graceMs: 100, killWaitMs: 1000 })
            .catch(() => undefined);
        }
        return error;
      };
      const assertPolicy = async () => {
        try {
          await capturedNative.assertPermissions(nativePermissions);
          await this.options.assertEffectivePolicy({
            command,
            host,
            permissions: nativePermissions,
            externalSessionId: capturedNative.id,
          });
          signal.throwIfAborted();
          if (stopping)
            throw new OpenCodeTransportError("policy recheck after Stop", true);
        } catch {
          throw fenceFailure("effective policy unavailable");
        }
      };
      const authorizeDispatch = async (
        payerSignal: AbortSignal,
        sessionID = capturedNative.id,
      ) => {
        let checkLease: () => void;
        try {
          await assertPolicy();
          if (sessionID !== capturedNative.id)
            await capturedNative.assertPermissions(
              nativePermissions,
              sessionID,
            );
          checkLease = await payerGuard.authorize(
            payerSignal,
            sessionID,
            owner.transport,
          );
        } catch {
          throw fenceFailure("effective payer unavailable");
        }
        return () => {
          try {
            checkLease();
            if (
              stopping ||
              observationIntegritySealed ||
              owner.transport.continuity !== "ready"
            )
              throw new OpenCodeTransportError("continuation fenced", true);
          } catch {
            throw fenceFailure("effective payer unavailable at dispatch");
          }
        };
      };

      const capturedMapper = mapper;
      const fingerprint = JSON.stringify(command);
      void owner.process.exited.then(() => {
        if (
          !observationIntegritySealed ||
          owner.transport.observationIntegrityLost
        )
          observationIntegrityLost = true;
        rejectForeground(new OpenCodeTransportError("process exited", true));
      });
      void owner.transport.disconnected.then(() => {
        if (
          !observationIntegritySealed ||
          owner.transport.observationIntegrityLost
        )
          observationIntegrityLost = true;
        rejectForeground(new OpenCodeTransportError("stream continuity", true));
      });
      const abort = () => {
        stopping = true;
        capturedNative.fence();
        host.fence();
        rejectForeground(new OpenCodeTransportError("attempt aborted", true));
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const checkQuiescence: HarnessLiveSession["awaitQuiescence"] = async ({
        timeoutMs,
      }) => {
        if (
          observationIntegrityLost ||
          owner.transport.observationIntegrityLost
        )
          return {
            status: "unknown",
            session,
            reason: "observation_integrity_lost",
          };
        if (
          provenQuiescence?.status === "quiescent" &&
          provenQuiescence.observationIntegrity === "complete"
        )
          return provenQuiescence;
        if (owner.transport.continuity !== "ready")
          return {
            status: "unknown",
            session,
            reason: "observation_integrity_lost",
          };
        if (pendingObservations > 0)
          return { status: "unknown", session, reason: "work_still_running" };
        if (
          !Number.isSafeInteger(timeoutMs) ||
          timeoutMs < 0 ||
          timeoutMs > 60_000
        )
          throw new OpenCodeTransportError("quiescence deadline", false);
        if (!stopping) {
          if (owner.transport.continuity !== "ready")
            return { status: "unknown", session, reason: "transport_lost" };
          const recovery = await capturedNative.reconcile();
          if (
            !capturedMapper.foregroundEnded ||
            recovery.activeSessionIds.length ||
            capturedNative.pendingNativeWork > 0
          ) {
            return {
              status: "unknown",
              session,
              reason: "work_still_running",
            };
          }
        }
        if (capturedNative.pendingNativeWork > 0)
          return { status: "unknown", session, reason: "work_still_running" };
        const evidence = HarnessQuiescenceSchema.parse(
          await this.options.proveQuiescence({
            host,
            session,
            timeoutMs,
            interrupted: stopping,
          }),
        );
        if (!sameSession(session, evidence.session))
          throw new OpenCodeTransportError("quiescence binding", true);
        if (
          evidence.status === "quiescent" &&
          (evidence.observationIntegrity !== "complete" ||
            observationIntegrityLost ||
            owner.transport.observationIntegrityLost ||
            owner.transport.continuity !== "ready")
        ) {
          observationIntegrityLost = true;
          return {
            status: "unknown",
            session,
            reason: "observation_integrity_lost",
          };
        }
        if (
          evidence.status === "quiescent" &&
          (pendingObservations > 0 || capturedNative.pendingNativeWork > 0)
        )
          return { status: "unknown", session, reason: "work_still_running" };
        if (evidence.status === "quiescent" && !terminalPublished) {
          // The real proof must include an ordered stream/drain barrier, not just process exit.
          // Never manufacture observationIntegrity from a zero exit code or foreground completion.
          if (!owner.transport.sealObservationStream())
            return { status: "unknown", session, reason: "work_still_running" };
          observationIntegritySealed = true;
          host.fence();
          capturedNative.fence();
          try {
            if (capturedMapper.foregroundEnded) {
              await deliver({
                session,
                externalTurnId: capturedNative.externalTurnId,
                payload: capturedMapper.terminalAfterQuiescence(evidence),
              });
            }
            await deliver({
              session,
              externalTurnId: capturedNative.externalTurnId,
              payload: { kind: "quiescence", evidence },
            });
            if (
              observationIntegrityLost ||
              owner.transport.observationIntegrityLost
            )
              throw new OpenCodeTransportError(
                "observation integrity barrier failed",
                true,
              );
            terminalPublished = true;
            provenQuiescence = evidence;
          } catch {
            observationIntegrityLost = true;
            observationIntegritySealed = false;
            provenQuiescence = undefined;
            return {
              status: "unknown",
              session,
              reason: "observation_integrity_lost",
            };
          }
        }
        return evidence;
      };
      const live: HarnessLiveSession = {
        session,
        execute: async (request) => {
          if (
            executing ||
            stopping ||
            request.signal.aborted ||
            JSON.stringify(HarnessStartCommandSchema.parse(request.command)) !==
              fingerprint
          ) {
            throw new OpenCodeTransportError(
              "execute binding or duplicate",
              true,
            );
          }
          executing = true;
          execution = (async () => {
            request.signal.throwIfAborted();
            const beforeDispatch = await authorizeDispatch(request.signal);
            beforeDispatch();
            await capturedNative.prompt(command.prompt);
            await foreground;
            while (!stopping) {
              const evidence = await live.awaitQuiescence({ timeoutMs: 2000 });
              if (evidence.status === "quiescent") return;
              if (evidence.reason !== "work_still_running")
                throw new OpenCodeTransportError(
                  "quiescence unavailable",
                  true,
                );
              await delay(500, undefined, { signal: request.signal });
            }
            throw new OpenCodeTransportError("attempt stopped", true);
          })();
          void execution.catch(() => undefined);
          return execution;
        },
        observeExisting: ({ signal: observerSignal }) => {
          if (observerSignal.aborted || !execution)
            return Promise.reject(
              new OpenCodeTransportError("no live execution to observe", true),
            );
          // Only the existing provider execution is observed. No prompt/steer/reply is sent.
          return execution;
        },
        control: async (raw) => {
          const control = HarnessControlCommandSchema.parse(raw);
          const origin =
            control.kind === "reply" || control.kind === "user_input_reply"
              ? control.reply.replyTo.session
              : control.session;
          if (!sameSession(session, origin))
            throw new OpenCodeTransportError("control binding", true);
          if (control.kind === "steer")
            throw new OpenCodeTransportError(
              "steer capability unavailable",
              false,
            );
          if (control.kind === "user_input_reply") {
            const reply = control.reply;
            const form = capturedNative.pendingForm(reply.replyTo.requestId);
            if (
              stopping ||
              !form ||
              form.sessionID !== reply.replyTo.origin ||
              reply.replyTo.authOwnerGeneration !==
                command.selection.authOwnerGeneration
            ) {
              throw new OpenCodeTransportError("question origin", true);
            }
            const answer = questionAnswer(form, reply.response);
            const beforeDispatch = await authorizeDispatch(
              signal,
              reply.replyTo.origin,
            );
            beforeDispatch();
            if (
              capturedNative.pendingForm(form.id)?.sessionID !== form.sessionID
            )
              throw new OpenCodeTransportError("question origin changed", true);
            await capturedNative.replyForm(form.id, answer, beforeDispatch);
            return { accepted: true };
          }
          if (control.kind === "reply") {
            const reply = control.reply;
            if (
              stopping ||
              reply.grantScope ||
              reply.replyTo.authOwnerGeneration !==
                command.selection.authOwnerGeneration ||
              capturedNative.permissionOrigin(reply.replyTo.requestId) !==
                reply.replyTo.origin
            ) {
              throw new OpenCodeTransportError("permission origin", true);
            }
            const beforeDispatch = await authorizeDispatch(
              signal,
              reply.replyTo.origin,
            );
            beforeDispatch();
            if (
              capturedNative.permissionOrigin(reply.replyTo.requestId) !==
              reply.replyTo.origin
            )
              throw new OpenCodeTransportError(
                "permission origin changed",
                true,
              );
            await capturedNative.replyPermission(
              reply.replyTo.requestId,
              reply.decision === "approved" ? "once" : "reject",
              beforeDispatch,
            );
            return { accepted: true };
          }
          stopping = true;
          capturedNative.fence();
          host.fence();
          if (control.kind === "interrupt") {
            await capturedNative.interrupt();
            return { accepted: true };
          }
          await host.terminateProcesses({ graceMs: 1000, killWaitMs: 1000 });
          await owner.transport.close();
          signal.removeEventListener("abort", abort);
          return { accepted: true };
        },
        awaitQuiescence: (request) => {
          if (
            !Number.isSafeInteger(request.timeoutMs) ||
            request.timeoutMs < 0 ||
            request.timeoutMs > 60_000
          )
            return Promise.reject(
              new OpenCodeTransportError("quiescence deadline", false),
            );
          if (
            observationIntegrityLost ||
            owner.transport.observationIntegrityLost
          )
            return Promise.resolve({
              status: "unknown",
              session,
              reason: "observation_integrity_lost",
            });
          if (
            provenQuiescence?.status === "quiescent" &&
            provenQuiescence.observationIntegrity === "complete"
          )
            return Promise.resolve(provenQuiescence);
          if (!quiescenceJob) {
            quiescenceJob = checkQuiescence(request);
            void quiescenceJob
              .finally(() => {
                quiescenceJob = undefined;
              })
              .catch(() => undefined);
          }
          return quiescenceJob;
        },
      };
      return live;
    } catch {
      host.fence();
      await host.terminateProcesses({ graceMs: 100, killWaitMs: 1000 });
      await owner.transport.close();
      throw new OpenCodeTransportError("session initialization", true);
    }
  }
}

function sameSession(a: HarnessSession, b: HarnessSession): boolean {
  return (
    a.runAttemptId === b.runAttemptId &&
    a.instanceId === b.instanceId &&
    a.externalSessionId === b.externalSessionId &&
    a.processGeneration === b.processGeneration
  );
}
