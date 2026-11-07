import { lstat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { LocalPersistence } from "@repo/event-store/local";
import type { DefaultGitService } from "@repo/git-service";
import {
  PermissionPolicySchema,
  type PermissionPolicy,
} from "@repo/permission-policy";
import {
  PermissionProfileIdSchema,
  UserIdSchema,
  WorkerIdSchema,
  type EventCursor,
  type LifecycleEvent,
  type PermissionProfileId,
  type TurnAdmission,
  type WorkerId,
} from "@repo/platform-protocol";
import {
  RuntimeKernelError,
  type RuntimeKernelDependencies,
} from "@repo/runtime-kernel";
import {
  MemoryWorkspaceManifestRepository,
  parseWorkspaceManifest,
} from "@repo/workspace-core";
import { RegistryToolAuthorization } from "@legioncode/execution-engine/runtime/contracts/RegistryToolAuthorization";
import { createLocalTurnAdmission } from "@legioncode/execution-engine/runtime/desktop/LocalTurnAdmission";
import { LocalTurnExecutor } from "@legioncode/execution-engine/runtime/desktop/LocalReadOnlyTurnExecutor";
import type { LocalTurnAttemptIdentity } from "@legioncode/execution-engine/runtime/desktop/LocalReadOnlyTurnExecutor";
import type { LocalTurnExecutionCapability } from "@legioncode/execution-engine/runtime/desktop/LocalTurnExecutionCapability";
import { createLocalNativeProviderPorts } from "@legioncode/execution-engine/runtime/desktop/LocalNativeProviderPorts";
import { createNativeReadExecutionService } from "@legioncode/execution-engine/runtime/desktop/LocalNativeReadExecutionService";
import { NativeFilesystemBridge } from "@legioncode/execution-engine/runtime/desktop/NativeFilesystemBridge";
import {
  createProtectedProviderGateway,
  type ProtectedProviderGatewayOptions,
} from "@legioncode/execution-engine/runtime/provider/ProtectedProviderGateway";
import type { LocalTurnRuntime } from "./local-turns.js";
import type { LocalWorkspaceExecutionBinding } from "./local-workspace.js";

type LifecycleStore = LocalPersistence["lifecycleEvents"];
type NativeMessages = Parameters<
  typeof createLocalNativeProviderPorts
>[0]["messages"];

export interface LocalNativeRuntimeOptions {
  readonly persistence: Pick<
    LocalPersistence,
    "turnAdmissions" | "lifecycleEvents"
  >;
  readonly workerId: WorkerId;
  readonly permissionProfileId: PermissionProfileId;
  readonly permissionPolicy: PermissionPolicy;
  readonly nativeFilesystemHelperPath: string;
  readonly resolveRuntimeCredential: ProtectedProviderGatewayOptions["resolveCredential"];
  readonly capability?: LocalTurnExecutionCapability<LocalWorkspaceExecutionBinding>;
  /** The same host writer owner releases only after this factory's combined proof. */
  readonly releaseExecution?: (
    attempt: LocalTurnAttemptIdentity,
    proof: LocalTurnExecutor<LocalWorkspaceExecutionBinding>["awaitResourceRelease"],
  ) => Promise<boolean>;
  /** Canonical Git owner. Success requires actual child/pipe closure; rejection is uncertain. */
  readonly createGitService: (
    binding: LocalWorkspaceExecutionBinding,
    signal: AbortSignal,
  ) => Pick<DefaultGitService, "probeRepository" | "getStatus">;
}

/** Concrete 6C composition. The host keeps the one root FD and closes it after execution. */
export function createLocalNativeRuntime(
  options: LocalNativeRuntimeOptions,
): LocalTurnRuntime {
  const workerId = WorkerIdSchema.parse(options.workerId);
  const permissionProfileId = PermissionProfileIdSchema.parse(
    options.permissionProfileId,
  );
  const permissionPolicy = PermissionPolicySchema.parse(
    options.permissionPolicy,
  );
  const helperPath = options.nativeFilesystemHelperPath;
  if (!isAbsolute(helperPath) || helperPath.includes("\0")) {
    throw new Error(
      "Native runtime requires the trusted absolute filesystem helper path",
    );
  }
  const approvals = createApprovalWaitPort(options.persistence.lifecycleEvents);
  const capability: LocalTurnExecutionCapability<LocalWorkspaceExecutionBinding> =
    options.capability
      ? Object.freeze({ ...options.capability })
      : { artifactCapture: "omitted_read_only" };
  const releaseExecution = options.releaseExecution;
  if (capability.artifactCapture === "required" && !releaseExecution) {
    throw new Error(
      "Captured execution requires the canonical host writer's release port",
    );
  }
  return {
    createAdmission(input) {
      if (input.workspace.readiness !== "ready")
        throw new Error("Native workspace is unavailable");
      return createLocalTurnAdmission(
        {
          thread: input.thread,
          workspaceId: input.workspace.workspaceId,
          clientRequestId: input.clientRequestId,
          prompt: input.prompt,
          providerId: input.providerId,
          modelId: input.modelId,
          workerId,
          permissionProfileId,
        },
        capability.artifactCapture === "required" ? "auto_edit" : "ask",
      );
    },
    createExecutor(binding) {
      binding.assertCurrent();
      const filesystem = new NativeFilesystemBridge({
        helperPath,
        rootDirectory: binding.rootDirectory,
      });
      let manifestGitClosureUnknown = false;
      let attempt: LocalTurnAttemptIdentity | undefined;
      const executor = new LocalTurnExecutor<LocalWorkspaceExecutionBinding>({
        capability,
        producerId: workerId,
        lifecycleEvents: options.persistence.lifecycleEvents,
        async bindWorkspace(admission, signal) {
          signal.throwIfAborted();
          binding.assertCurrent();
          if (
            admission.run.workspaceId !== binding.workspace.workspaceId ||
            admission.run.workerId !== workerId ||
            admission.run.permissionProfileId !== permissionProfileId
          ) {
            throw new Error(
              "Native admission does not match its trusted runtime binding",
            );
          }
          return binding;
        },
        createReadExecutionService(admission, bound) {
          return createNativeReadExecutionService({
            attempt: {
              workspaceId: admission.run.workspaceId,
              threadId: admission.run.threadId,
              runId: admission.run.id,
              turnId: admission.turn.id,
              runAttemptId: admission.runAttemptId,
            },
            binding: bound,
            readFile: filesystem.readFile.bind(filesystem),
          });
        },
        async createKernelPorts(admission, bound, signal, execution) {
          signal.throwIfAborted();
          const manifests = new MemoryWorkspaceManifestRepository();
          try {
            const git = options.createGitService(bound, signal);
            await manifests.create(
              await readManifest(admission, bound, git, signal),
            );
          } catch (error) {
            // A Git rejection (including constructor failure after spawn) is not
            // positive physical closure. Retain this exact host binding/fence.
            manifestGitClosureUnknown = true;
            throw error;
          }
          const messages = await readConversation(
            options.persistence,
            admission,
            signal,
          );
          bound.assertCurrent();
          signal.throwIfAborted();
          const gateway = createProtectedProviderGateway({
            providerId: admission.run.providerId,
            modelId: admission.run.modelId,
            resolveCredential: options.resolveRuntimeCredential,
          });
          const provider = createLocalNativeProviderPorts({
            admission,
            messages,
            gateway,
            signal,
            execution,
          });
          return {
            ...provider,
            workspaceManifests: manifests,
            toolAuthorization: new RegistryToolAuthorization({
              async resolve(profileId) {
                if (profileId !== permissionProfileId)
                  throw new Error("Unknown native permission profile");
                return permissionPolicy;
              },
            }),
            approvals,
          };
        },
      });
      const proveRelease = async (turnId: TurnAdmission["turn"]["id"]) => {
        if (manifestGitClosureUnknown) return false;
        const releasable = await executor.awaitResourceRelease(turnId);
        return releasable && !manifestGitClosureUnknown;
      };
      return {
        execute(admission) {
          const identity: LocalTurnAttemptIdentity = {
            workspaceId: admission.run.workspaceId,
            threadId: admission.run.threadId,
            runId: admission.run.id,
            turnId: admission.turn.id,
            runAttemptId: admission.runAttemptId,
          };
          const previous = attempt;
          if (
            previous &&
            (Object.keys(identity) as Array<keyof typeof identity>).some(
              (key) => identity[key] !== previous[key],
            )
          )
            throw new Error(
              "Native host executor already owns a different admitted attempt",
            );
          attempt ??= Object.freeze(identity);
          return executor.execute(admission);
        },
        interrupt: executor.interrupt.bind(executor),
        resolveApproval: executor.resolveApproval,
        async awaitResourceRelease(turnId) {
          if (!(await proveRelease(turnId))) return false;
          if (capability.artifactCapture === "omitted_read_only") return true;
          if (!attempt || attempt.turnId !== turnId || !releaseExecution)
            return false;
          return releaseExecution(attempt, proveRelease);
        },
      };
    },
  };
}

async function readManifest(
  admission: TurnAdmission,
  binding: LocalWorkspaceExecutionBinding,
  git: ReturnType<LocalNativeRuntimeOptions["createGitService"]>,
  signal: AbortSignal,
) {
  await assertHeldRoot(binding, signal);
  const probe = await git.probeRepository({
    workspaceRoot: binding.filesystemRoot,
  });
  const status = await git.getStatus({
    runId: admission.run.id,
    workspaceRoot: binding.filesystemRoot,
  });
  await assertHeldRoot(binding, signal);
  if (
    probe.repositoryRoot !== binding.filesystemRoot ||
    probe.repositoryIdentity !== binding.workspace.repositoryIdentity ||
    !status.branch.oid ||
    !status.branch.head ||
    status.branch.detached ||
    probe.branch !== status.branch.head ||
    binding.workspace.branch !== status.branch.head
  ) {
    throw new Error(
      "Native read-only execution requires the current granted repository, commit and named branch",
    );
  }
  return parseWorkspaceManifest({
    runId: admission.run.id,
    workspaceId: admission.run.workspaceId,
    repoOwner: admission.run.userId,
    repoName: basename(binding.filesystemRoot),
    repoUrl: pathToFileURL(binding.filesystemRoot).href,
    baseBranch: status.branch.head,
    workingBranch: status.branch.head,
    baseSha: status.branch.oid,
    headSha: status.branch.oid,
    executionLocation: "desktop_local",
    workerId: admission.run.workerId,
    filesystemRoot: binding.filesystemRoot,
    artifactNamespace: `${admission.run.workspaceId}/${admission.run.id}/${admission.runAttemptId}`,
    permissionProfileId: admission.run.permissionProfileId,
    state: status.isDirty ? "dirty" : "ready",
    lastError: null,
    createdAt: admission.run.createdAt,
    updatedAt: admission.run.updatedAt,
  });
}

async function assertHeldRoot(
  binding: LocalWorkspaceExecutionBinding,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  binding.signal.throwIfAborted();
  binding.assertCurrent();
  const [opened, current] = await Promise.all([
    binding.rootDirectory.stat(),
    lstat(binding.filesystemRoot),
  ]);
  if (
    !opened.isDirectory() ||
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    opened.dev !== current.dev ||
    opened.ino !== current.ino
  ) {
    throw new Error("Granted native root changed during execution preparation");
  }
  binding.assertCurrent();
  signal.throwIfAborted();
}

/** Project only stored admission prompts and canonically completed assistant items. */
async function readConversation(
  persistence: LocalNativeRuntimeOptions["persistence"],
  current: TurnAdmission,
  signal: AbortSignal,
): Promise<NativeMessages> {
  const messages: NativeMessages = [];
  let afterCursor: EventCursor | null = null;
  do {
    signal.throwIfAborted();
    const page = await persistence.turnAdmissions.listByThread({
      threadId: current.run.threadId,
      afterCursor,
      limit: 100,
    });
    for (const admission of page.admissions) {
      if (admission.run.workspaceId !== current.run.workspaceId)
        throw new Error("Native history crosses a workspace boundary");
      if (admission.turn.id === current.turn.id) {
        messages.push({ role: "user", content: prompt(current) });
        return messages;
      }
      messages.push({ role: "user", content: prompt(admission) });
      const events = await readLifecycle(
        persistence.lifecycleEvents,
        admission.turn.id,
        signal,
      );
      const assistantIds = new Set(
        events.flatMap((event) =>
          event.type === "item.started" &&
          event.payload.kind === "assistant_message"
            ? [event.itemId]
            : [],
        ),
      );
      for (const event of events) {
        if (
          event.type === "item.completed" &&
          assistantIds.has(event.itemId) &&
          typeof event.payload.result.output === "string"
        ) {
          messages.push({
            role: "assistant",
            content: event.payload.result.output,
          });
        }
      }
    }
    afterCursor = page.nextCursor;
  } while (afterCursor !== null);
  throw new Error(
    "Native admission is missing from canonical conversation history",
  );
}

function prompt(admission: TurnAdmission): string {
  if (
    admission.userMessage.type !== "user_message" ||
    typeof admission.userMessage.content.text !== "string"
  ) {
    throw new Error("Canonical admission has no user prompt");
  }
  return admission.userMessage.content.text;
}

async function readLifecycle(
  store: LifecycleStore,
  turnId: TurnAdmission["turn"]["id"],
  signal?: AbortSignal,
): Promise<LifecycleEvent[]> {
  const events: LifecycleEvent[] = [];
  let afterSequence: number | null = null;
  do {
    signal?.throwIfAborted();
    const page = await store.replay({ turnId, afterSequence, limit: 1000 });
    events.push(...page.events);
    afterSequence = page.nextSequence;
  } while (afterSequence !== null);
  return events;
}

/** No decision registry: 05 delivers to kernel.resolveApproval; this reads its canonical receipt. */
function createApprovalWaitPort(
  store: LifecycleStore,
): RuntimeKernelDependencies["approvals"] {
  return {
    async waitForDecision(input) {
      while (true) {
        input.signal?.throwIfAborted();
        const events = await readLifecycle(store, input.turnId, input.signal);
        for (const event of events) {
          if (event.runAttemptId !== input.runAttemptId) continue;
          if (
            event.type === "approval.decided" &&
            event.approvalId === input.request.approvalId
          ) {
            const decidedBy =
              event.payload.decidedBy === null
                ? null
                : UserIdSchema.parse(event.payload.decidedBy);
            const reason = event.payload.reason;
            if (reason !== null && typeof reason !== "string")
              throw new Error("Canonical approval receipt has no reason");
            return {
              decision:
                event.payload.status === "timed_out"
                  ? "denied"
                  : event.payload.status,
              decidedBy,
              reason,
              ...(event.payload.status === "timed_out"
                ? { timedOut: true }
                : {}),
              ...(event.payload.grantScope
                ? { grantScope: event.payload.grantScope }
                : {}),
            };
          }
          if (
            event.type === "turn.completed" ||
            event.type === "turn.failed" ||
            event.type === "turn.interrupted"
          ) {
            throw new RuntimeKernelError(
              "approval_not_active",
              "Native approval is no longer active",
            );
          }
        }
        await waitForReplay(input.signal);
      }
    },
  };
}

function waitForReplay(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, 50);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
