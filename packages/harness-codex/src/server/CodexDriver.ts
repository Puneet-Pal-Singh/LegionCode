import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { isAbsolute } from "node:path";
import type {
  HarnessDriver,
  HarnessLiveSession,
} from "@repo/harness-core/server";
import {
  HarnessSessionSchema,
  HarnessControlCommandSchema,
  HarnessObservationPayloadSchema,
  type HarnessObservationPayload,
} from "@repo/worker-protocol";
import { codexRuntime, codexRuntimePin } from "./runtime.js";
import {
  CodexStdioTransport,
  CodexTransportError,
  type CodexServerRequest,
} from "./transport/CodexStdioTransport.js";
import { initializeCodex } from "./initialize.js";
import { CodexUsageReader } from "./CodexUsageReader.js";
import { CodexNativeSession } from "./CodexNativeSession.js";
import {
  codexEventPayload,
  codexItemId,
  nativeIdentity,
} from "./CodexEventMapper.js";
import { codexQuestion } from "./CodexQuestionMapper.js";
import { codexPermission } from "./CodexPermissionMapper.js";
import { CodexAuthentication } from "./CodexAuthentication.js";

/** Concrete native loop driver; the shared host owns launch policy, delivery journal and process cleanup. */
export class CodexDriver implements HarnessDriver {
  readonly kind = "codex" as const;
  private readonly options: Readonly<{
    experimentalQuestions?: boolean;
    modelProvider?: string;
    policy?: Readonly<{ id: string; revision: string }>;
    accountBinding?: Readonly<{
      instanceId: string;
      connectionId: string;
      authOwnerGeneration: number;
      identityFingerprint: string;
    }>;
  }>;
  constructor(
    private readonly executable: string,
    options: {
      experimentalQuestions?: boolean;
      modelProvider?: string;
      policy?: Readonly<{ id: string; revision: string }>;
      accountBinding?: Readonly<{
        instanceId: string;
        connectionId: string;
        authOwnerGeneration: number;
        identityFingerprint: string;
      }>;
    } = {},
  ) {
    this.options = Object.freeze({
      ...options,
      ...(options.accountBinding
        ? { accountBinding: Object.freeze({ ...options.accountBinding }) }
        : {}),
      ...(options.policy
        ? { policy: Object.freeze({ ...options.policy }) }
        : {}),
    });
  }

  async open(
    input: Parameters<HarnessDriver["open"]>[0],
  ): Promise<HarnessLiveSession> {
    const { command, host, signal, observe } = input;
    const { selection } = command;
    const runtimePin = codexRuntimePin(process.platform, process.arch);
    if (
      !this.options.accountBinding ||
      this.options.accountBinding.instanceId !== selection.instanceId ||
      this.options.accountBinding.connectionId !== selection.connectionId ||
      this.options.accountBinding.authOwnerGeneration !==
        selection.authOwnerGeneration ||
      !/^[a-f0-9]{64}$/.test(this.options.accountBinding.identityFingerprint) ||
      !this.options.policy ||
      this.options.policy.id !== selection.policyId ||
      this.options.policy.revision !== selection.policyRevision ||
      !isAbsolute(this.executable) ||
      signal.aborted ||
      selection.harness !== this.kind ||
      selection.runtimeVersion !== codexRuntime.version ||
      selection.protocolVersion !== codexRuntime.schemaSha256 ||
      selection.transport !== "codex_app_server_stdio" ||
      command.filesystemRoot !== host.workspaceRoot ||
      host.environment.CODEX_HOME !== host.instanceDirectory
    )
      throw new Error("Codex binding/runtime unavailable");
    if (
      command.resumeSession &&
      command.resumeSession.instanceId !== selection.instanceId
    )
      throw new Error("Codex resume instance mismatch");
    if (
      selection.billingSource !== "api_key" &&
      selection.billingSource !== "subscription"
    )
      throw new Error("Codex selected payer route is unsupported");
    const authentication = new CodexAuthentication(
      selection.billingSource,
      this.options.accountBinding.identityFingerprint,
      host.environment,
      this.options.modelProvider ?? "openai",
    );
    const digest = createHash("sha256")
      .update(await readFile(this.executable))
      .digest("hex");
    if (digest !== runtimePin.binarySha256)
      throw new Error("Codex executable pin mismatch");
    if (signal.aborted) throw new Error("Codex opening interrupted");
    const child = await host.launch({
      executable: this.executable,
      args: authentication.launchArgs(),
    });
    let stopped = false;
    let externalTurnId: string | null = null;
    let terminal = false;
    let terminalPayloadFingerprint: string | null = null;
    let accountVerified = false;
    let finalOutput = "";
    let executing = false;
    let pendingBytes = 0;
    let pendingCount = 0;
    let queue = Promise.resolve();
    let resolveTurn!: (id: string) => void;
    let rejectTurn!: (error: Error) => void;
    const turnReady = new Promise<string>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    void turnReady.catch(() => undefined);
    let resolveDone!: () => void;
    let rejectDone!: (error: Error) => void;
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    void done.catch(() => undefined);
    const pendingQuestions = new Map<
      string,
      ReturnType<typeof codexQuestion>
    >();
    const pendingReplies = new Map<
      string,
      ReturnType<typeof codexPermission>
    >();
    const fail = () => {
      if (stopped) return;
      stopped = true;
      authentication.cancel();
      pendingReplies.clear();
      pendingQuestions.clear();
      rejectTurn(new Error("Codex execution unavailable"));
      rejectDone(new Error("Codex execution outcome requires reconciliation"));
      host.fence();
      void host
        .terminateProcesses({ graceMs: 100, killWaitMs: 1000 })
        .catch(() => undefined);
    };
    // Register cancellation before initialize/open RPC, not after prompt delivery.
    signal.addEventListener("abort", fail, { once: true });
    if (signal.aborted) fail();
    const enqueue = (raw: unknown, action: () => Promise<void>) => {
      const size = Buffer.byteLength(JSON.stringify(raw));
      if (
        stopped ||
        pendingCount >= 256 ||
        pendingBytes + size > 8 * 1024 * 1024
      ) {
        fail();
        return;
      }
      pendingCount++;
      pendingBytes += size;
      queue = queue
        .then(async () => {
          if (stopped) {
            return;
          }
          await turnReady;
          if (stopped) {
            return;
          }
          await action();
        })
        .catch(() => {
          fail();
        })
        .finally(() => {
          pendingCount--;
          pendingBytes -= size;
        });
    };
    let session: ReturnType<typeof HarnessSessionSchema.parse> | null = null;
    const emit = async (payload: HarnessObservationPayload) => {
      if (!session || stopped) throw new Error("Codex observation fenced");
      // Decide foreground/background ownership only inside the serialized processing queue.
      // Exact session and native turn checks precede this call; no late fact is reassigned.
      const owned =
        terminal &&
        payload.kind !== "external_terminal" &&
        payload.kind !== "quiescence"
          ? { ...payload, background: true as const }
          : payload;
      await observe({ session, externalTurnId, payload: owned });
    };
    const notification = (method: string, raw: unknown) => {
      try {
        if (authentication.observeNotification(method, raw)) return;
      } catch {
        fail();
        return;
      }
      if (
        method === "model/rerouted" ||
        (accountVerified &&
          (method === "account/updated" ||
            method === "account/gatewayOAuth/changed"))
      ) {
        fail();
        return;
      }
      if (
        ![
          "item/started",
          "item/completed",
          "thread/tokenUsage/updated",
          "turn/completed",
        ].includes(method)
      )
        return;
      enqueue(raw, async () => {
        const identity =
          method === "turn/completed"
            ? (() => {
                const value = z
                  .object({
                    threadId: z.string(),
                    turn: z.object({ id: z.string() }),
                  })
                  .parse(raw);
                return { threadId: value.threadId, turnId: value.turn.id };
              })()
            : nativeIdentity.parse(raw);
        if (
          !session ||
          identity.threadId !== session.externalSessionId ||
          identity.turnId !== externalTurnId
        )
          throw new Error("Codex event identity mismatch");
        if (method === "turn/completed") {
          const turn = z
            .object({
              turn: z.object({
                id: z.string().min(1),
                status: z.enum(["completed", "interrupted", "failed"]),
                completedAt: z
                  .number()
                  .int()
                  .nonnegative()
                  .max(8_640_000_000_000)
                  .nullish(),
              }),
            })
            .parse(raw).turn;
          const status = turn.status;
          const payload = HarnessObservationPayloadSchema.parse({
            kind: "external_terminal",
            status,
            providerCompletedAt:
              turn.completedAt == null
                ? null
                : new Date(turn.completedAt * 1000).toISOString(),
            itemId: codexItemId(selection.runAttemptId, turn.id),
            output: finalOutput,
            error:
              status === "completed"
                ? null
                : {
                    code:
                      status === "interrupted"
                        ? "command_cancelled"
                        : "command_failed",
                    message: `Codex turn ${status}`,
                    retryable: false,
                    correlationId: null,
                    details: null,
                  },
          });
          // Compare the exact bound tuple and validated canonical payload before
          // emission. Include native data so redaction cannot conceal a changed
          // provider error/item. Object key order is not a payload difference.
          const fingerprint = createHash("sha256")
            .update(
              JSON.stringify(
                { selection, session, externalTurnId, payload, native: raw },
                (_key, value: unknown) =>
                  value !== null &&
                  typeof value === "object" &&
                  !Array.isArray(value)
                    ? Object.fromEntries(
                        Object.entries(value).sort(([a], [b]) =>
                          a < b ? -1 : a > b ? 1 : 0,
                        ),
                      )
                    : value,
              ),
            )
            .digest("hex");
          if (terminalPayloadFingerprint !== null) {
            if (fingerprint !== terminalPayloadFingerprint)
              throw new Error("Conflicting Codex terminal");
            return;
          }
          native.observeTerminal(raw);
          await emit(payload);
          // A failed/ambiguous canonical commit never installs a successful
          // deduplication receipt and is never retried by this driver.
          terminalPayloadFingerprint = fingerprint;
          terminal = true;
          pendingReplies.clear();
          pendingQuestions.clear();
          resolveDone();
          return;
        }
        const payload = codexEventPayload(
          method,
          raw,
          selection.runAttemptId,
          selection.modelId,
        );
        if (!terminal && payload?.kind === "assistant_text") {
          const item = z
            .object({
              item: z.object({ phase: z.string().nullable().optional() }),
            })
            .parse(raw).item;
          if (item.phase !== "commentary") {
            if (finalOutput.length + payload.text.length > 1_048_576)
              throw new Error("Codex final output overflow");
            finalOutput += payload.text;
          }
        }
        if (payload) await emit(payload);
      });
    };
    const request = (raw: CodexServerRequest) => {
      // Internal-only auth, dynamic-tool and unsupported permission/question APIs are never exposed.
      if (
        raw.method === "item/tool/requestUserInput" &&
        this.options.experimentalQuestions === true
      ) {
        enqueue(raw.params, async () => {
          if (!session || !externalTurnId)
            throw new Error("Codex question has no active turn");
          const mapped = codexQuestion(
            raw,
            session,
            selection.authOwnerGeneration,
            externalTurnId,
          );
          const key = mapped.payload.replyTo.requestId;
          if (
            pendingQuestions.has(key) ||
            pendingQuestions.size + pendingReplies.size >= 64
          )
            throw new Error("Codex request overflow");
          pendingQuestions.set(key, mapped);
          await emit(mapped.payload);
        });
        return;
      }
      if (
        ![
          "item/commandExecution/requestApproval",
          "item/fileChange/requestApproval",
        ].includes(raw.method)
      ) {
        raw.reject(-32601);
        return;
      }
      enqueue(raw.params, async () => {
        if (!session || !externalTurnId)
          throw new Error("Codex request has no active turn");
        const mapped = codexPermission(
          raw,
          session,
          selection.authOwnerGeneration,
          externalTurnId,
        );
        const key = mapped.payload.replyTo.requestId;
        if (pendingReplies.has(key) || pendingReplies.size >= 64)
          throw new Error("Codex request overflow");
        pendingReplies.set(key, mapped);
        await emit(mapped.payload);
      });
    };
    const transport = new CodexStdioTransport({
      input: child.child.stdin,
      output: child.child.stdout,
      onNotification: notification,
      onRequest: request,
      onClose: (error) => {
        if (error.reason !== "closed") fail();
        else inspectClosedOutput();
      },
    });
    const native = new CodexNativeSession(transport);
    const accountReader = new CodexUsageReader(transport);
    const verifyPayer = async () => {
      await authentication.verify(accountReader);
      accountVerified = true;
    };
    // Process exit can precede buffered stdout and its final queued terminal.
    // Only a natural frame-complete EOF followed by the ordered ACK drain may
    // decide that the terminal was absent. Neither exit nor local close proves it.
    let closureInspection: Promise<void> | undefined;
    function inspectClosedOutput(): void {
      if (!closureInspection) {
        closureInspection = (async () => {
          if (!(await drainClosedOutput(30_000)) || !terminal) fail();
        })().catch(() => fail());
      }
    }
    async function drainClosedOutput(timeoutMs: number): Promise<boolean> {
      const deadline = performance.now() + timeoutMs;
      const closure = await transport.awaitOutputClosure({ timeoutMs });
      if (closure.kind !== "natural_eof") return false;
      // At natural EOF every complete frame has synchronously entered this queue.
      // Each action awaits the canonical observation ACK before this tail settles.
      const orderedTail = queue;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const drained = await Promise.race([
          orderedTail.then(() => true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(
              () => resolve(false),
              Math.max(0, deadline - performance.now()),
            );
          }),
        ]);
        return (
          drained &&
          !stopped &&
          orderedTail === queue &&
          pendingCount === 0 &&
          pendingBytes === 0
        );
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    void child.exited.then(inspectClosedOutput);
    try {
      await child.ready;
      if (stopped) throw new Error("Codex opening interrupted");
      const initialized = await initializeCodex(
        transport,
        "0.0.0",
        this.options.experimentalQuestions === true,
      );
      if (initialized.codexHome !== host.instanceDirectory)
        throw new Error("Codex instance home mismatch");
      await authentication.establish(transport);
      await verifyPayer();
      if (stopped || signal.aborted)
        throw new Error("Codex account binding fenced");
      const common = {
        cwd: host.workspaceRoot,
        model: selection.modelId,
        modelProvider: this.options.modelProvider ?? "openai",
        config: {
          sandbox_workspace_write: {
            writable_roots: [],
            network_access: false,
            exclude_tmpdir_env_var: true,
            exclude_slash_tmp: true,
          },
        },
        sandbox: "workspace-write" as const,
        approvalPolicy: "untrusted" as const,
        approvalsReviewer: "user" as const,
      };
      const threadId = command.resumeSession
        ? await native.resume({
            ...common,
            threadId: command.resumeSession.externalSessionId,
            excludeTurns: true,
          })
        : await native.open({ ...common, ephemeral: false });
      session = HarnessSessionSchema.parse({
        runAttemptId: selection.runAttemptId,
        instanceId: selection.instanceId,
        externalSessionId: threadId,
        processGeneration: host.processGeneration,
      });
      if (stopped) throw new Error("Codex opening interrupted");
      const learnedSession = session;
      const fingerprint = JSON.stringify(command);
      return {
        session: learnedSession,
        execute: async (execution) => {
          if (
            command.mode !== "start" ||
            executing ||
            stopped ||
            execution.signal.aborted ||
            JSON.stringify(execution.command) !== fingerprint
          )
            throw new Error("Codex attempt unavailable");
          executing = true;
          execution.signal.addEventListener("abort", fail, { once: true });
          try {
            await verifyPayer();
            if (stopped || execution.signal.aborted)
              throw new Error("Codex payer binding fenced");
            externalTurnId = await native.start({
              threadId,
              model: selection.modelId,
              approvalPolicy: "untrusted",
              approvalsReviewer: "user",
              sandboxPolicy: {
                type: "workspaceWrite",
                writableRoots: [],
                networkAccess: false,
                excludeTmpdirEnvVar: true,
                excludeSlashTmp: true,
              },
              input: [
                { type: "text", text: command.prompt, text_elements: [] },
              ],
            });
            resolveTurn(externalTurnId);
            await done;
            await queue;
          } catch (error) {
            fail();
            throw error;
          } finally {
            execution.signal.removeEventListener("abort", fail);
          }
        },
        observeExisting: async ({ signal: observationSignal }) => {
          if (stopped || observationSignal.aborted)
            throw new Error("Codex observation attachment unavailable");
          // Same-generation recovery joins the original execution and its pending
          // observation ACKs. The shared host replays its delivery journal first.
          // A fresh process has no trusted external-turn ID in this API; picking
          // the latest native turn would attribute another attempt's work.
          if (!executing)
            throw new Error(
              "Codex cold recovery requires canonical external turn binding",
            );
          observationSignal.addEventListener("abort", fail, { once: true });
          try {
            await turnReady;
            if (stopped) throw new Error("Codex recovery attachment fenced");
            if (!terminal) await native.read();
            await done;
            await queue;
          } catch (error) {
            fail();
            throw error;
          } finally {
            observationSignal.removeEventListener("abort", fail);
          }
        },
        control: async (raw) => {
          const control = HarnessControlCommandSchema.parse(raw);
          const target =
            control.kind === "reply" || control.kind === "user_input_reply"
              ? control.reply.replyTo.session
              : control.session;
          if (
            stopped ||
            JSON.stringify(target) !== JSON.stringify(learnedSession)
          )
            throw new Error("Codex control fenced");
          try {
            if (control.kind === "dispose") {
              fail();
              transport.close();
              return { accepted: true };
            }
            if (control.kind === "interrupt") {
              pendingReplies.clear();
              pendingQuestions.clear();
              if (externalTurnId) await native.interrupt();
              else fail();
              return { accepted: true };
            }
            if (!externalTurnId || (terminal && control.kind === "steer"))
              throw new Error("Codex turn unavailable");
            if (control.kind === "steer") {
              await native.steer({
                threadId,
                expectedTurnId: control.expectedExternalTurnId,
                clientUserMessageId: control.accepted.inputId,
                input: [
                  { type: "text", text: control.text, text_elements: [] },
                ],
              });
            } else if (control.kind === "user_input_reply") {
              const handle = pendingQuestions.get(
                control.reply.replyTo.requestId,
              );
              if (!handle) throw new Error("Codex question reply unavailable");
              handle.reply(control.reply);
              pendingQuestions.delete(control.reply.replyTo.requestId);
            } else {
              const handle = pendingReplies.get(
                control.reply.replyTo.requestId,
              );
              if (!handle) throw new Error("Codex reply unavailable");
              handle.reply(control.reply);
              pendingReplies.delete(control.reply.replyTo.requestId);
            }
            return { accepted: true };
          } catch (error) {
            // Lost start/steer/reply/interrupt outcomes cannot leave this owner
            // available for another command. Canonical recovery decides next steps.
            if (
              error instanceof CodexTransportError &&
              error.outcome === "unknown"
            ) {
              fail();
            }
            throw error;
          }
        },
        awaitQuiescence: async ({ timeoutMs }) => {
          if (
            !Number.isSafeInteger(timeoutMs) ||
            timeoutMs < 0 ||
            timeoutMs > 60_000
          )
            throw new Error("Invalid Codex cleanup duration");
          if (!terminal && !stopped)
            return {
              status: "unknown",
              session: learnedSession,
              reason: "work_still_running",
            };
          signal.removeEventListener("abort", fail);
          const deadline = performance.now() + timeoutMs;
          const settlements = await host.terminateProcesses({
            graceMs: Math.min(100, timeoutMs),
            killWaitMs: Math.max(0, timeoutMs - 100),
          });
          const remaining = () =>
            Math.max(0, Math.floor(deadline - performance.now()));
          const [observationsClosed, pipes] = await Promise.all([
            drainClosedOutput(remaining()),
            child.awaitOutputClosure?.({ timeoutMs: remaining() }),
          ]);
          // Close only after the non-destructive EOF and ordered canonical ACK
          // barrier. A missing receipt or destroyed/partial pipe remains lost.
          transport.close();
          if (
            !observationsClosed ||
            pipes?.kind !== "natural_eof" ||
            pipes.processGeneration !== learnedSession.processGeneration
          ) {
            return {
              status: "unknown",
              session: learnedSession,
              reason: "observation_integrity_lost",
            };
          }
          if (
            !settlements.length ||
            settlements.some(
              (receipt) =>
                receipt.kind !== "process_group_quiesced" ||
                receipt.processGeneration !== learnedSession.processGeneration,
            )
          ) {
            return {
              status: "unknown",
              session: learnedSession,
              reason: "work_still_running",
            };
          }
          // Natural output/ACK closure and group absence are separate evidence,
          // not an attestation that descendants could not escape their scope.
          // A real host confinement/quiescence authority is still required.
          return {
            status: "unknown",
            session: learnedSession,
            reason: "unsupported",
          };
        },
      };
    } catch (error) {
      fail();
      transport.close();
      throw error;
    }
  }
}
