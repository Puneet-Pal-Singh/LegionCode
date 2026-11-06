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
      /** Resolve only the admitted connection/model/policy through existing authorities. */
      readonly resolveConfiguration: (command: HarnessStartCommand) => Promise<{
        readonly model: ModelRef;
        readonly permissions: NonNullable<SessionCreateInput["permissions"]>;
        readonly agent?: string;
        readonly priorThreadTokens: number;
      }>;
      /** Real enforced scope proof. A process-group receipt cannot implement this callback. */
      readonly proveQuiescence: (input: {
        readonly host: HarnessHost;
        readonly session: HarnessSession;
        readonly timeoutMs: number;
        /** Completed work must finish naturally; cancellation cannot be relabeled completed. */
        readonly interrupted: boolean;
      }) => Promise<HarnessQuiescence>;
    },
  ) {}

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
      command.selection.protocolVersion !== "2.2.5" ||
      command.filesystemRoot !== host.workspaceRoot ||
      command.startSnapshot.turnId !== command.selection.turnId ||
      command.startSnapshot.phase !== "start"
    ) {
      throw new OpenCodeTransportError("admission binding", false);
    }
    requireOpenCodeVersion(command.selection.runtimeVersion);
    signal.throwIfAborted();
    const configuration = structuredClone(
      await this.options.resolveConfiguration(command),
    );
    if (
      !Number.isSafeInteger(configuration.priorThreadTokens) ||
      configuration.priorThreadTokens < 0
    )
      throw new OpenCodeTransportError("canonical usage baseline", false);
    signal.throwIfAborted();
    const owner = await OpenCodeServerOwner.start({
      host,
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
          permissions: configuration.permissions,
          agent: configuration.agent,
          location: { directory: host.workspaceRoot },
        },
        async (event) => {
          if (!mapper || !native || !executing)
            throw new OpenCodeTransportError("work before execute", true);
          for (const payload of mapper.map(event)) {
            // HarnessSessionManager owns journal-before-send and validates the exact commit ACK.
            await observe({
              session,
              externalTurnId: native.externalTurnId,
              payload,
            });
          }
          if (mapper.foregroundEnded) resolveForeground();
        },
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
        priorThreadTokens: configuration.priorThreadTokens,
      });
      const capturedNative = native;
      const capturedMapper = mapper;
      const fingerprint = JSON.stringify(command);
      void owner.process.exited.then(() =>
        rejectForeground(new OpenCodeTransportError("process exited", true)),
      );
      void owner.transport.disconnected.then(() =>
        rejectForeground(new OpenCodeTransportError("stream continuity", true)),
      );
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
        if (provenQuiescence?.status === "quiescent") return provenQuiescence;
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
        if (evidence.status === "quiescent" && !terminalPublished) {
          host.fence();
          capturedNative.fence();
          if (capturedMapper.foregroundEnded) {
            await observe({
              session,
              externalTurnId: capturedNative.externalTurnId,
              payload: capturedMapper.terminalAfterQuiescence(evidence),
            });
          }
          await observe({
            session,
            externalTurnId: capturedNative.externalTurnId,
            payload: { kind: "quiescence", evidence },
          });
          terminalPublished = true;
          provenQuiescence = evidence;
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
            await capturedNative.replyForm(
              form.id,
              questionAnswer(form, reply.response),
            );
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
            await capturedNative.replyPermission(
              reply.replyTo.requestId,
              reply.decision === "approved" ? "once" : "reject",
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
          if (provenQuiescence?.status === "quiescent")
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
