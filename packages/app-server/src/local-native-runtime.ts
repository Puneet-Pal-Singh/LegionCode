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
  LocalTurnConfigurationSchema,
  PRODUCT_MODES,
  UserIdSchema,
  WorkerIdSchema,
  type EventCursor,
  type LifecycleEvent,
  type PermissionProfileId,
  type TurnAdmission,
  type WorkerId,
  type ProductMode,
  type LocalTurnConfiguration,
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
import { reconcileLocalNativePlanTurn } from "@legioncode/execution-engine/runtime/desktop/LocalNativePlanRecovery";
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
import type { LocalTurnMediaPort } from "./local-turn-media.js";
import { attachPreparedLocalImages, localUserProviderMessage } from "./local-turn-images.js";

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
  readonly resolvePermissionPolicy: (productMode: ProductMode) => Promise<PermissionPolicy>;
  readonly nativeFilesystemHelperPath: string;
  readonly resolveRuntimeCredential: ProtectedProviderGatewayOptions["resolveCredential"];
  readonly media?: LocalTurnMediaPort;
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
  ) =>
    | Pick<DefaultGitService, "probeRepository" | "getStatus" | "readRepositoryHead">
    | Promise<Pick<DefaultGitService, "probeRepository" | "getStatus" | "readRepositoryHead">>;
}

/** Concrete 6C composition. The host keeps the one root FD and closes it after execution. */
export function createLocalNativeRuntime(
  options: LocalNativeRuntimeOptions,
): LocalTurnRuntime {
  const workerId = WorkerIdSchema.parse(options.workerId);
  const permissionProfileId = PermissionProfileIdSchema.parse(
    options.permissionProfileId,
  );
  const profileFor = (configuration: LocalTurnConfiguration) =>
    PermissionProfileIdSchema.parse(`${permissionProfileId}_${configuration.productMode}`);
  const helperPath = options.nativeFilesystemHelperPath;
  if (!isAbsolute(helperPath) || helperPath.includes("\0")) {
    throw new Error(
      "Native runtime requires the trusted absolute filesystem helper path",
    );
  }
  const approvals = createApprovalWaitPort(options.persistence.lifecycleEvents);
  const availableCapability: LocalTurnExecutionCapability<LocalWorkspaceExecutionBinding> =
    options.capability
      ? Object.freeze({ ...options.capability })
      : { artifactCapture: "omitted_read_only" };
  const releaseExecution = options.releaseExecution;
  if (availableCapability.artifactCapture === "required" && !releaseExecution) {
    throw new Error(
      "Captured execution requires the canonical host writer's release port",
    );
  }
  return {
    reconcileLostTurn(admission) {
      return reconcileLocalNativePlanTurn({
        admission,
        lifecycleEvents: options.persistence.lifecycleEvents,
        workerId,
        permissionProfileId,
        producerId: workerId,
        clock: { now: () => new Date().toISOString() },
      });
    },
    configurationOptions: {
      modes: availableCapability.artifactCapture === "required" ? ["plan", "build"] : ["plan"],
      productModes: Object.values(PRODUCT_MODES),
      productModesByMode: {
        plan: Object.values(PRODUCT_MODES),
        ...(availableCapability.artifactCapture === "required" ? { build: [PRODUCT_MODES.ASK_ALWAYS] } : {}),
      },
      ...(options.media ? { attachments: options.media.limits } : {}),
    },
    async createAdmission(input) {
      if (input.workspace.readiness !== "ready")
        throw new Error("Native workspace is unavailable");
      const configuration = LocalTurnConfigurationSchema.parse(input.configuration);
      if (configuration.mode === "build" && availableCapability.artifactCapture !== "required") {
        throw new Error("Local Build mode requires the actual captured execution ports");
      }
      if (configuration.mode === "build" && configuration.productMode !== PRODUCT_MODES.ASK_ALWAYS) {
        throw new Error("Local Build mode requires Supervised permissions");
      }
      const admission = createLocalTurnAdmission(
        {
          thread: input.thread,
          workspaceId: input.workspace.workspaceId,
          clientRequestId: input.clientRequestId,
          prompt: input.prompt,
          providerId: input.providerId,
          modelId: input.modelId,
          workerId,
          permissionProfileId: profileFor(configuration),
          configuration,
          imageFingerprint: input.media?.preparation.fingerprint,
        },
        configuration.mode === "build" ? "auto_edit" : "plan",
      );
      if (!input.media) return admission;
      if (!options.media) throw new Error("Local image admission is unavailable");
      return attachPreparedLocalImages(admission, input.media.preparation, input.media.imageCount, options.media);
    },
    createExecutor(binding, preparedAdmission) {
      binding.assertCurrent();
      const configuration = readConfiguration(preparedAdmission);
      const selectedProfileId = profileFor(configuration);
      const capability: LocalTurnExecutionCapability<LocalWorkspaceExecutionBinding> =
        configuration.mode === "build" ? availableCapability : { artifactCapture: "omitted_read_only" };
      let permissionPolicy: Promise<PermissionPolicy> | undefined;
      const resolvePolicy = () => permissionPolicy ??= Promise.resolve()
        .then(() => options.resolvePermissionPolicy(configuration.productMode))
        .then((policy) => PermissionPolicySchema.parse(policy));
      const toolAuthorization = new RegistryToolAuthorization({
        async resolve(profileId) {
          if (profileId !== selectedProfileId) throw new Error("Unknown native permission profile");
          return resolvePolicy();
        },
      });
      const filesystem = new NativeFilesystemBridge({
        helperPath,
        rootDirectory: binding.rootDirectory,
      });
      let manifestGitClosureUnknown = false;
      let kernelPortsReturned = false;
      let attempt: LocalTurnAttemptIdentity | undefined;
      const executor = new LocalTurnExecutor<LocalWorkspaceExecutionBinding>({
        capability,
        toolAuthorization,
        producerId: workerId,
        lifecycleEvents: options.persistence.lifecycleEvents,
        ...(capability.artifactCapture === "omitted_read_only" ? {
          awaitPreparationQuiescence: async (identity: LocalTurnAttemptIdentity) => {
            const expected = {
              workspaceId: preparedAdmission.run.workspaceId,
              threadId: preparedAdmission.run.threadId,
              runId: preparedAdmission.run.id,
              turnId: preparedAdmission.turn.id,
              runAttemptId: preparedAdmission.runAttemptId,
            };
            if ((Object.keys(expected) as Array<keyof typeof expected>).some((key) => identity[key] !== expected[key])) return false;
            // No NativeFS tool can run before this factory returns kernel ports.
            // Every attempted Git operation either returned positive closure or
            // set the sticky unknown marker. The Engine additionally requires
            // settled execution and exact durable canonical terminal evidence.
            return !kernelPortsReturned && !manifestGitClosureUnknown;
          },
        } : {}),
        async bindWorkspace(admission, signal) {
          signal.throwIfAborted();
          binding.assertCurrent();
          if (
            admission.run.workspaceId !== binding.workspace.workspaceId ||
            admission.run.workerId !== workerId ||
            admission.run.permissionProfileId !== selectedProfileId ||
            readConfiguration(admission).mode !== configuration.mode ||
            readConfiguration(admission).productMode !== configuration.productMode ||
            admission.run.mode !== (configuration.mode === "build" ? "auto_edit" : "plan")
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
          await resolvePolicy();
          signal.throwIfAborted();
          const manifests = new MemoryWorkspaceManifestRepository();
          try {
            const git = await options.createGitService(bound, signal);
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
            options.media,
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
          const kernelPorts = {
            ...provider,
            workspaceManifests: manifests,
            toolAuthorization,
            approvals,
          };
          kernelPortsReturned = true;
          return kernelPorts;
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

function readConfiguration(admission: TurnAdmission): LocalTurnConfiguration {
  if (admission.userMessage.type !== "user_message") {
    throw new Error("Native execution requires its admitted user configuration");
  }
  return LocalTurnConfigurationSchema.parse(admission.userMessage.content.configuration);
}

async function readManifest(
  admission: TurnAdmission,
  binding: LocalWorkspaceExecutionBinding,
  git: Awaited<ReturnType<LocalNativeRuntimeOptions["createGitService"]>>,
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
  const head = await git.readRepositoryHead({
    runId: admission.run.id,
    workspaceRoot: binding.filesystemRoot,
  });
  await assertHeldRoot(binding, signal);
  const objectIdLength = head.objectFormat === "sha1" ? 40 : head.objectFormat === "sha256" ? 64 : 0;
  const absentHead = "0".repeat(objectIdLength);
  const headMatchesStatus = objectIdLength > 0 && head.headSha.length === objectIdLength && /^[0-9a-f]+$/.test(head.headSha) && (
    head.kind === "born"
      ? status.branch.oid === head.headSha && head.headSha !== absentHead
      : head.kind === "unborn" && status.branch.oid === "(initial)" && head.headSha === absentHead
  );
  if (
    probe.repositoryRoot !== binding.filesystemRoot ||
    probe.repositoryIdentity !== binding.workspace.repositoryIdentity ||
    !headMatchesStatus ||
    head.branchRef !== `refs/heads/${status.branch.head}` ||
    !status.branch.head ||
    status.branch.detached ||
    probe.branch !== status.branch.head ||
    binding.workspace.branch !== status.branch.head
  ) {
    throw new Error(
      "Native execution requires the current granted repository, named branch and verified HEAD state",
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
    // For unborn repositories, this is the Git owner's format-sized absent-HEAD
    // guard. It is never a synthesized commit or a claim that HEAD exists.
    baseSha: head.headSha,
    headSha: head.headSha,
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
  media?: LocalTurnMediaPort,
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
        messages.push(await localUserProviderMessage(current, media, signal));
        return messages;
      }
      messages.push(await localUserProviderMessage(admission, media, signal));
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
