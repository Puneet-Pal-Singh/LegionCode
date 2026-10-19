import {
  ResumeTurnReceiptSchema,
  StartedThreadInputReceiptSchema,
  StartQueuedThreadInputCommandSchema,
  ThreadInputReceiptSchema,
  TurnScopeBootstrapSchema,
  type ThreadInputCommand,
  type ResumeTurnReceipt,
} from "@repo/platform-protocol";
import { z } from "zod";
import type { Env } from "../../types/ai";
import { ResumeTurnService } from "../turn-admissions/ResumeTurnService";
import {
  dispatchAdmittedTurn,
  prepareAdmittedTurnModel,
  settleUnclaimedStartupFailure,
} from "./AdmittedTurnExecutionService";
import { createThreadInputCommandIdentity } from "./ThreadInputCommandIdentity";
import { withTurnAdmissionRepository } from "../turn-admissions/TurnAdmissionPersistenceFactory";
import { withThreadInputRepository } from "./ThreadInputPersistenceFactory";
import { withTranscriptRepository } from "../sessions/TranscriptPersistenceFactory";
import { assertChatImageModelSupport } from "../chat/ChatImageModelPolicy";
import { ThreadInputConflictError } from "@repo/persistence";
import { readRunTerminal } from "./AdmittedTurnExecutionService";
import { RunAdmissionService } from "../../runtime/RunAdmissionService";
import { toRuntimeRunMode } from "../chat/RuntimeRunMode";
import { resolveSessionRepositoryContext } from "../workspaces/SessionRepositoryContext";

type ResumeTurnCommand = Extract<
  ThreadInputCommand,
  { operation: "turn.resume" }
>;
type StartQueuedThreadInputCommand = Extract<
  ThreadInputCommand,
  { operation: "thread.input.start" }
>;
type StartedThreadInputReceipt = z.infer<
  typeof StartedThreadInputReceiptSchema
>;

/** Owns commands that reserve and dispatch a whole admitted turn. */
export class ThreadInputCommandService {
  constructor(private readonly env: Env) {}

  async reconcileTerminal(input: {
    readonly request: Request;
    readonly executionContext?: ExecutionContext;
    readonly runId: string;
    readonly turnId: string;
    readonly userId: string;
    readonly sessionId: string;
    readonly threadId: string;
    readonly workspaceId: string;
    readonly correlationId: string;
  }): Promise<void> {
    const type = await readRunTerminal(this.env, input.runId, input.turnId);
    if (!type) return;
    await this.onTurnTerminal({ ...input, type });
  }

  scheduleTerminalReconciliation(input: {
    readonly response: Response;
    readonly request: Request;
    readonly executionContext?: ExecutionContext;
    readonly runId: string;
    readonly turnId: string;
    readonly userId: string;
    readonly sessionId: string;
    readonly threadId: string;
    readonly workspaceId: string;
    readonly correlationId: string;
  }): void {
    if (!input.executionContext) return;
    const { response, ...reconciliation } = input;
    input.executionContext.waitUntil(
      response
        .clone()
        .arrayBuffer()
        .then(() => this.reconcileTerminal(reconciliation))
        .catch((error: unknown) => {
          console.error("[thread-input/terminal] queue reconciliation failed", {
            correlationId: input.correlationId,
            turnId: input.turnId,
            error: error instanceof Error ? error.message : String(error),
          });
        }),
    );
  }

  async resume(input: {
    readonly request: Request;
    readonly executionContext?: ExecutionContext;
    readonly userId: string;
    readonly sessionId: string;
    readonly command: ResumeTurnCommand;
    readonly correlationId: string;
  }): Promise<ResumeTurnReceipt> {
    const { request, command } = input;
    const identity = await createThreadInputCommandIdentity(
      `resume:${input.sessionId}:${command.clientCommandId}`,
    );
    const existing = await withTurnAdmissionRepository(this.env, (repository) =>
      repository.getByTurnId(identity.turnId),
    );
    if (
      existing?.state === "admitted" &&
      existing.executionState !== "pending" &&
      existing.clientMessageId === command.clientCommandId &&
      existing.userId === input.userId &&
      existing.sessionId === input.sessionId &&
      existing.threadId === command.threadId &&
      existing.workspaceId === command.workspaceId &&
      existing.runAttemptId === identity.runAttemptId
    ) {
      const resumed = await new ResumeTurnService(this.env).resume({
        sessionId: input.sessionId,
        userId: input.userId,
        threadId: command.threadId,
        workspaceId: command.workspaceId,
        expectedTurnId: command.expectedTurnId,
        expectedRunAttemptId: command.expectedRunAttemptId,
        terminalSequence: command.expectedTerminalSequence,
        clientCommandId: command.clientCommandId,
        configuration: command.configuration,
        ...identity,
      });
      return ResumeTurnReceiptSchema.parse({
        status: "resumed",
        clientCommandId: command.clientCommandId,
        continuationOfTurnId: resumed.admission.continuationOfTurnId,
        originalPromptId: resumed.originalPromptId,
        turnId: resumed.admission.turnId,
        runAttemptId: resumed.admission.runAttemptId,
        runId: resumed.admission.runId,
      });
    }
    const admissionService = new RunAdmissionService(this.env);
    const grant = await admissionService.enforce(
      {
        userId: input.userId,
        workspaceId: command.workspaceId,
        threadId: command.threadId,
        runAttemptId: identity.runAttemptId,
        mode: admissionMode(command.configuration?.mode),
      },
      input.correlationId,
    );
    let leaseTransferred = false;
    let preserveLease = false;
    let leaseReleased = false;
    const releaseGrantOnce = async () => {
      if (leaseReleased) return;
      leaseReleased = true;
      await admissionService.release(grant, input.correlationId);
    };
    let startupFailure:
      | {
          run: import("@repo/persistence").RunRecord;
          identity: ReturnType<typeof TurnScopeBootstrapSchema.parse>;
        }
      | undefined;
    let dispatchStarted = false;
    try {
      const resumed = await new ResumeTurnService(this.env).resume({
        sessionId: input.sessionId,
        userId: input.userId,
        threadId: command.threadId,
        workspaceId: command.workspaceId,
        expectedTurnId: command.expectedTurnId,
        expectedRunAttemptId: command.expectedRunAttemptId,
        terminalSequence: command.expectedTerminalSequence,
        clientCommandId: command.clientCommandId,
        configuration: command.configuration,
        ...identity,
      });
      const turnIdentity = TurnScopeBootstrapSchema.parse({
        workspaceId: command.workspaceId,
        threadId: command.threadId,
        turnId: resumed.admission.turnId,
        runAttemptId: resumed.admission.runAttemptId,
        continuationOfTurnId: resumed.admission.continuationOfTurnId,
        originalPromptId: resumed.admission.originalPromptId,
      });
      startupFailure = { run: resumed.run, identity: turnIdentity };
      if (resumed.admission.executionState === "pending") {
        dispatchStarted = true;
        leaseTransferred = true;
        await dispatchAdmittedTurn({
          request,
          env: this.env,
          executionContext: input.executionContext,
          sessionId: input.sessionId,
          run: resumed.run,
          userId: input.userId,
          workspaceId: command.workspaceId,
          correlationId: input.correlationId,
          identity: turnIdentity,
          prompt: resumed.prompt.text,
          promptMessageId: resumed.originalPromptId,
          configuration: resumed.configuration,
          resumeSnapshotRef: resumed.resumeSnapshot,
          repository: resumed.repository,
          onStartupFailure: async (error) => {
            const settled = await settleUnclaimedStartupFailure({
              env: this.env,
              userId: input.userId,
              sessionId: input.sessionId,
              run: resumed.run,
              workspaceId: command.workspaceId,
              identity: turnIdentity,
              correlationId: input.correlationId,
              error,
            });
            preserveLease = !settled;
            return settled;
          },
          onDispatchSettled: releaseGrantOnce,
          onTerminal: (type) =>
            this.onTurnTerminal({
              type,
              request,
              executionContext: input.executionContext,
              userId: input.userId,
              sessionId: input.sessionId,
              threadId: command.threadId,
              workspaceId: command.workspaceId,
              correlationId: input.correlationId,
            }),
        });
      } else if (
        resumed.admission.executionState === "running" ||
        resumed.admission.executionState === "recovery_required"
      ) {
        preserveLease = true;
      }
      return ResumeTurnReceiptSchema.parse({
        status: "resumed",
        clientCommandId: command.clientCommandId,
        continuationOfTurnId: resumed.admission.continuationOfTurnId,
        originalPromptId: resumed.originalPromptId,
        turnId: resumed.admission.turnId,
        runAttemptId: resumed.admission.runAttemptId,
        runId: resumed.admission.runId,
      });
    } catch (error) {
      if (startupFailure && !dispatchStarted) {
        const settled = await settleUnclaimedStartupFailure({
          env: this.env,
          userId: input.userId,
          sessionId: input.sessionId,
          run: startupFailure.run,
          workspaceId: command.workspaceId,
          identity: startupFailure.identity,
          correlationId: input.correlationId,
          error,
        });
        preserveLease = !settled;
      } else if (!startupFailure) {
        preserveLease = await admissionMayOwnLease(this.env, identity.turnId);
      }
      throw error;
    } finally {
      if (!leaseTransferred && !preserveLease) await releaseGrantOnce();
    }
  }

  async startQueuedInput(input: {
    readonly request: Request;
    readonly executionContext?: ExecutionContext;
    readonly userId: string;
    readonly sessionId: string;
    readonly command: StartQueuedThreadInputCommand;
    readonly correlationId: string;
    readonly explicitStart?: boolean;
  }): Promise<
    | StartedThreadInputReceipt
    | import("@repo/platform-protocol").ThreadInputReceipt
  > {
    const { command } = input;
    const scope = {
      sessionId: input.sessionId,
      userId: input.userId,
      threadId: command.threadId,
      workspaceId: command.workspaceId,
    };
    const item = await withThreadInputRepository(this.env, (repository) =>
      repository.getById({ ...scope, itemId: command.itemId }),
    );
    if (!item)
      throw new ThreadInputConflictError(
        "Queue item not found.",
        "queue_item_changed",
      );
    const repositoryContext = await resolveSessionRepositoryContext({
      env: this.env,
      userId: input.userId,
      sessionId: input.sessionId,
      workspaceId: command.workspaceId,
    });
    if (
      item.delivery !== "queue" ||
      (item.state === "pending" && item.version !== command.expectedVersion)
    ) {
      return ThreadInputReceiptSchema.parse({
        status: "conflict",
        code: "queue_item_changed",
        message: "Queue item changed or was already consumed.",
      });
    }
    const identities = await createThreadInputCommandIdentity(
      `queue-start:${input.sessionId}:${command.itemId}`,
    );
    const storedReceipt = item.receipt;
    if (storedReceipt?.status === "started") {
      const existing = await withTurnAdmissionRepository(
        this.env,
        (repository) => repository.getByTurnId(storedReceipt.turnId),
      );
      if (
        existing?.state === "admitted" &&
        existing.executionState !== "pending" &&
        existing.userId === input.userId &&
        existing.sessionId === input.sessionId &&
        existing.threadId === command.threadId &&
        existing.workspaceId === command.workspaceId &&
        existing.runAttemptId === storedReceipt.runAttemptId &&
        existing.runId === storedReceipt.runId
      ) {
        return storedReceipt;
      }
    }
    const admissionService = new RunAdmissionService(this.env);
    const grant = await admissionService.enforce(
      {
        userId: input.userId,
        workspaceId: command.workspaceId,
        threadId: command.threadId,
        runAttemptId: identities.runAttemptId,
        mode: admissionMode(item.configuration.mode),
      },
      input.correlationId,
    );
    let leaseTransferred = false;
    let preserveLease = false;
    let leaseReleased = false;
    const releaseGrantOnce = async () => {
      if (leaseReleased) return;
      leaseReleased = true;
      await admissionService.release(grant, input.correlationId);
    };
    let startupFailure:
      | {
          run: import("@repo/persistence").RunRecord;
          identity: ReturnType<typeof TurnScopeBootstrapSchema.parse>;
        }
      | undefined;
    let dispatchStarted = false;
    try {
      const modelMetadata = await prepareAdmittedTurnModel({
        env: this.env,
        run: {
          id: identities.runId,
          providerId: item.configuration.providerId ?? null,
          modelId: item.configuration.modelId ?? null,
        },
        userId: input.userId,
        workspaceId: command.workspaceId,
        configuration: item.configuration,
      });
      if (item.mediaRefs.length > 0) assertChatImageModelSupport(modelMetadata);
      const session = await withTranscriptRepository(
        this.env,
        async (repository) => {
          const listed = await repository.listSessions(input.userId);
          return (
            listed.sessions.find(
              (candidate) => candidate.id === input.sessionId,
            ) ?? null
          );
        },
      );
      if (!session) throw new Error("Conversation not found.");
      const requestFingerprint = await fingerprint({
        itemId: item.itemId,
        version: command.expectedVersion,
        text: item.text,
        mediaRefs: item.mediaRefs,
        configuration: item.configuration,
      });
      const result = await withTurnAdmissionRepository(this.env, (repository) =>
        repository.reserveQueuedStart({
          ...scope,
          expectedRevision: command.expectedThreadRevision,
          expectedVersion: item.version,
          itemId: item.itemId,
          ...identities,
          taskId: session.taskId ?? session.id,
          requestFingerprint,
          mode: item.configuration.mode ?? "auto_edit",
          providerId: item.configuration.providerId ?? null,
          modelId: item.configuration.modelId ?? null,
          branch: repositoryContext?.repositoryBranch ?? null,
          explicitStart: input.explicitStart ?? true,
          promptMessage: {
            parts: [
              {
                type: "text",
                content: {
                  text: item.text,
                  metadata: {
                    canonicalIdentity: {
                      threadId: command.threadId,
                      turnId: identities.turnId,
                      runAttemptId: identities.runAttemptId,
                    },
                    ...(item.mediaRefs.length
                      ? { imageAttachments: item.mediaRefs }
                      : {}),
                  },
                },
              },
            ],
          },
        }),
      );
      if (
        result.status !== "admitted" ||
        !result.admission ||
        !result.run ||
        !result.promptMessageId ||
        !result.item
      ) {
        const code =
          result.code === "turn_not_idle"
            ? "thread_not_idle"
            : result.code === "queue_paused"
              ? "queue_paused"
              : result.code === "queue_item_consumed"
                ? "queue_item_consumed"
                : "queue_revision_conflict";
        return ThreadInputReceiptSchema.parse({
          status: "conflict",
          code,
          message: result.code ?? "Queued start could not be admitted.",
        });
      }
      const turnIdentity = TurnScopeBootstrapSchema.parse({
        workspaceId: command.workspaceId,
        threadId: command.threadId,
        turnId: result.admission.turnId,
        runAttemptId: result.admission.runAttemptId,
      });
      startupFailure = { run: result.run, identity: turnIdentity };
      const receipt = StartedThreadInputReceiptSchema.parse({
        status: "started",
        itemId: item.itemId,
        turnId: result.admission.turnId,
        runAttemptId: result.admission.runAttemptId,
        runId: result.admission.runId,
      });
      if (result.item.receipt?.status !== "started") {
        const recorded = await withThreadInputRepository(
          this.env,
          (repository) =>
            repository.recordReceipt({
              ...scope,
              itemId: item.itemId,
              expectedVersion: result.item!.version,
              receipt,
              state: "consumed",
            }),
        );
        if (recorded.status !== "changed")
          throw new Error(
            "Queued start was admitted but its receipt requires reconciliation.",
          );
      }
      if (result.admission.executionState === "pending") {
        dispatchStarted = true;
        leaseTransferred = true;
        await dispatchAdmittedTurn({
          request: input.request,
          env: this.env,
          executionContext: input.executionContext,
          sessionId: input.sessionId,
          run: result.run,
          userId: input.userId,
          workspaceId: command.workspaceId,
          correlationId: input.correlationId,
          identity: turnIdentity,
          prompt: item.text,
          promptMessageId: result.promptMessageId,
          configuration: item.configuration,
          repository: repositoryContext,
          modelMetadata,
          onStartupFailure: async (error) => {
            const settled = await settleUnclaimedStartupFailure({
              env: this.env,
              userId: input.userId,
              sessionId: input.sessionId,
              run: result.run!,
              workspaceId: command.workspaceId,
              identity: turnIdentity,
              correlationId: input.correlationId,
              error,
            });
            preserveLease = !settled;
            return settled;
          },
          onDispatchSettled: releaseGrantOnce,
          onTerminal: (type) =>
            this.onTurnTerminal({
              type,
              request: input.request,
              executionContext: input.executionContext,
              userId: input.userId,
              sessionId: input.sessionId,
              threadId: command.threadId,
              workspaceId: command.workspaceId,
              correlationId: input.correlationId,
            }),
        });
      } else if (
        result.admission.executionState === "running" ||
        result.admission.executionState === "recovery_required"
      ) {
        preserveLease = true;
      }
      return receipt;
    } catch (error) {
      if (startupFailure && !dispatchStarted) {
        const settled = await settleUnclaimedStartupFailure({
          env: this.env,
          userId: input.userId,
          sessionId: input.sessionId,
          run: startupFailure.run,
          workspaceId: command.workspaceId,
          identity: startupFailure.identity,
          correlationId: input.correlationId,
          error,
        });
        preserveLease = !settled;
      } else if (!startupFailure) {
        preserveLease = await admissionMayOwnLease(this.env, identities.turnId);
      }
      throw error;
    } finally {
      if (!leaseTransferred && !preserveLease) await releaseGrantOnce();
    }
  }

  async onTurnTerminal(input: {
    readonly type: "turn.completed" | "turn.failed" | "turn.interrupted";
    readonly request: Request;
    readonly executionContext?: ExecutionContext;
    readonly userId: string;
    readonly sessionId: string;
    readonly threadId: string;
    readonly workspaceId: string;
    readonly correlationId: string;
  }): Promise<void> {
    const scope = {
      sessionId: input.sessionId,
      userId: input.userId,
      threadId: input.threadId,
      workspaceId: input.workspaceId,
    };
    if (input.type !== "turn.completed") {
      // Terminal append projects failure/Stop pause in the same canonical transaction.
      return;
    }
    const snapshot = await withThreadInputRepository(this.env, (repository) =>
      repository.list(scope),
    );
    if (snapshot.paused) return;
    const next = snapshot.items.find(
      (item) => item.delivery === "queue" && item.state === "pending",
    );
    if (!next) return;
    await this.startQueuedInput({
      request: input.request,
      executionContext: input.executionContext,
      userId: input.userId,
      sessionId: input.sessionId,
      correlationId: input.correlationId,
      explicitStart: false,
      command: StartQueuedThreadInputCommandSchema.parse({
        operation: "thread.input.start",
        threadId: input.threadId,
        workspaceId: input.workspaceId,
        itemId: next.itemId,
        expectedVersion: next.version,
        expectedThreadRevision: snapshot.revision,
      }),
    });
  }
}

async function fingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function admissionMode(mode: string | undefined): "build" | "plan" {
  return toRuntimeRunMode(mode);
}

async function admissionMayOwnLease(
  env: Env,
  turnId: string,
): Promise<boolean> {
  try {
    return (
      (await withTurnAdmissionRepository(env, (repository) =>
        repository.getByTurnId(turnId),
      )) !== null
    );
  } catch {
    return true;
  }
}
