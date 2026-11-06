import {
  AppServerEnvironmentIdSchema,
  HarnessModelsResponseSchema,
  HarnessInstanceStatusSchema,
  HarnessSelectionSchema,
  InterruptTurnRequestSchema,
  type HarnessSetupRequest,
} from "@repo/platform-protocol";
import {
  PostgresHarnessControlPlaneRepository,
  PostgresHarnessBindingRepository,
  PostgresTurnAdmissionRepository,
  HarnessControlPlaneConflictError,
} from "@repo/persistence";
import { AppServerController } from "../../controllers/AppServerController";
import { AppServerOperationError } from "@legioncode/app-server/server";
import { builtinProviderRegistry } from "@repo/provider-core";
import type {
  HarnessAdmissionAccountPort,
  HarnessAdmissionPrincipal,
} from "../../runtime/CloudHarnessAdmissionPorts";
import type { Env } from "../../types/ai";
import type {
  HostedHarnessConnectionService,
  HostedHarnessOperationContext,
} from "../../integration/app-server/HostedHarnessOperations";
import { composeHostedTurnCommands } from "../../integration/app-server/HostedTurnCommands";
import { withTranscriptRepository } from "../sessions/TranscriptPersistenceFactory";
import { withTurnAdmissionRepository } from "../turn-admissions/TurnAdmissionPersistenceFactory";
import { withWorkspaceRepository } from "../workspaces/WorkspacePersistenceFactory";
import { withBrainPersistenceRepository } from "../persistence/BrainPersistenceRepositoryFactory";
import { createPostgresHarnessConnectionService } from "../providers/stores/PostgresStoreFactory";
import { resolveBrainProviderProductPolicy } from "../../lib/provider-product-policy";
import { canUseProviderAtRuntime } from "@repo/shared-types";
import {
  createHostedHarnessConnectionService,
  type HostedHarnessControlPlane,
  type OwnedHarnessInstance,
} from "./HostedHarnessConnectionService";
import type { HarnessConnectionMetadata } from "./HarnessConnectionService";

type Repository = PostgresHarnessControlPlaneRepository;
type ConfiguredInstance = Awaited<ReturnType<Repository["setupInstance"]>>;

/** Concrete hosted control metadata. No provider or Node harness is launched here. */
export function createPostgresHostedHarnessControlPlane(
  env: Env,
): HostedHarnessControlPlane {
  const withRepository = <T>(action: (repository: Repository) => Promise<T>) =>
    withBrainPersistenceRepository(
      env,
      undefined,
      (client) => new PostgresHarnessControlPlaneRepository(client),
      action,
    ).catch((error: unknown) => {
      if (error instanceof HarnessControlPlaneConflictError) {
        if (error.code === "not_found") throw missing();
        if (error.code === "connection_unavailable")
          throw unavailable("Selected connection is unavailable");
        throw conflict();
      }
      throw error;
    });
  const authorizeEnvironment = async (
    context: HostedHarnessOperationContext,
  ) => {
    const configured = AppServerEnvironmentIdSchema.safeParse(
      (env as Env & { APP_SERVER_ENVIRONMENT_ID?: string })
        .APP_SERVER_ENVIRONMENT_ID,
    );
    if (!configured.success)
      throw unavailable("Hosted environment identity is not configured");
    if (context.environmentId !== configured.data) throw missing();
    const owned = await withWorkspaceRepository(env, async (repository) =>
      (await repository.listWorkspaces(context.userId)).some(
        ({ workspace }) =>
          workspace.id === context.workspaceId &&
          workspace.userId === context.userId &&
          workspace.status === "active",
      ),
    );
    if (!owned) throw missing();
  };
  const connectionService = (context: HostedHarnessOperationContext) =>
    createPostgresHarnessConnectionService(
      env,
      context.userId,
      context.workspaceId,
      {
        async authorize(scope) {
          if (
            scope.userId !== context.userId ||
            scope.workspaceId !== context.workspaceId
          )
            throw missing();
          await authorizeEnvironment(context);
        },
        async authorizeAttempt(binding) {
          await authorizeEnvironment(context);
          if (
            binding.userId !== context.userId ||
            binding.workspaceId !== context.workspaceId ||
            binding.environmentId !== context.environmentId
          )
            throw missing();
          await withBrainPersistenceRepository(
            env,
            undefined,
            (client) => ({
              admission: new PostgresTurnAdmissionRepository(client),
              binding: new PostgresHarnessBindingRepository(client),
            }),
            async (repositories) => {
              const admission = await repositories.admission.getByTurnId(
                binding.turnId,
              );
              const stored = await repositories.binding.read({
                userId: binding.userId,
                turnId: binding.turnId,
                runAttemptId: binding.runAttemptId,
              });
              if (
                !admission ||
                admission.userId !== context.userId ||
                admission.workspaceId !== context.workspaceId ||
                admission.runAttemptId !== binding.runAttemptId ||
                admission.state !== "admitted" ||
                admission.executionState !== "running" ||
                !stored
              )
                throw missing();
              if (
                stored.selection.userId !== context.userId ||
                stored.selection.workspaceId !== context.workspaceId ||
                stored.selection.runId !== admission.runId ||
                stored.selection.threadId !== admission.threadId
              )
                throw missing();
              const selected = HarnessSelectionSchema.unwrap()
                .pick({
                  connectionId: true,
                  authOwnerGeneration: true,
                  environmentId: true,
                })
                .parse(JSON.parse(stored.selection.selectionJson));
              if (
                selected.connectionId !== binding.connectionId ||
                selected.authOwnerGeneration !== binding.ownerGeneration ||
                selected.environmentId !== binding.environmentId ||
                selected.environmentId !== context.environmentId
              )
                throw missing();
            },
          );
        },
        async assertRouteAllowed(scope, providerId, kind) {
          if (
            scope.userId !== context.userId ||
            scope.workspaceId !== context.workspaceId
          )
            throw missing();
          const provider = builtinProviderRegistry.getProvider(providerId);
          if (kind !== "api_key")
            throw unavailable(
              "Subscription and provider-owned login routes require provider approval for this hosted environment",
            );
          if (
            !provider ||
            provider.authModes.includes("platform_managed") ||
            !canUseProviderAtRuntime(
              resolveBrainProviderProductPolicy(env),
              providerId,
            )
          )
            throw unavailable("Selected provider route is unavailable");
        },
        async fenceRevoked(scope, connectionId, ownerGeneration) {
          // Enumerate existing canonical conversations, then verify each target
          // against admission + frozen binding rather than trusting UI run IDs.
          const sessions = await withTranscriptRepository(
            env,
            async (repository) => {
              const [current, archived] = await Promise.all([
                repository.listSessions(scope.userId),
                repository.listArchivedSessions(scope.userId),
              ]);
              return [...current.sessions, ...archived];
            },
          );
          const active = [];
          const seen = new Set<string>();
          for (const session of sessions) {
            if (!session.activeRunId || seen.has(session.id)) continue;
            seen.add(session.id);
            const admission = await withTurnAdmissionRepository(
              env,
              (repository) =>
                repository.getBySessionAndRunId(
                  session.id,
                  session.activeRunId!,
                ),
            );
            if (
              !admission ||
              admission.userId !== scope.userId ||
              admission.state !== "admitted" ||
              admission.executionState === "settled"
            )
              continue;
            const stored = await withBrainPersistenceRepository(
              env,
              undefined,
              (client) => new PostgresHarnessBindingRepository(client),
              (repository) =>
                repository.read({
                  userId: scope.userId,
                  turnId: admission.turnId,
                  runAttemptId: admission.runAttemptId,
                }),
            );
            if (!stored) continue;
            const selected = HarnessSelectionSchema.unwrap()
              .pick({ connectionId: true, authOwnerGeneration: true })
              .parse(JSON.parse(stored.selection.selectionJson));
            if (
              selected.connectionId === connectionId &&
              selected.authOwnerGeneration < ownerGeneration
            )
              active.push(admission);
          }
          const commands = composeHostedTurnCommands(env, scope.userId);
          for (const attempt of active) {
            const params = InterruptTurnRequestSchema.parse({
              runId: attempt.runId,
              workspaceId: attempt.workspaceId,
              sessionId: attempt.sessionId,
              threadId: attempt.threadId,
              turnId: attempt.turnId,
              runAttemptId: attempt.runAttemptId,
              reason: "Selected provider connection was revoked",
            });
            const result = await commands.interruptTurn(params);
            if (!result.accepted && result.status !== "settled")
              throw unavailable(
                "Credential revoked; execution Stop is pending",
              );
          }
          // Stop acceptance is not quiescence; runtime retains leases through settlement.
        },
      },
    );
  const ownedScope = (context: HostedHarnessOperationContext) => ({
    userId: context.userId,
    workspaceId: context.workspaceId,
    environmentId: context.environmentId,
  });
  const readInstance = (
    context: HostedHarnessOperationContext,
    instanceId: string,
  ) =>
    withRepository((repository) =>
      repository.readInstance(ownedScope(context), instanceId),
    );
  return {
    authorizeEnvironment,
    connectionService,
    async setupInstance(context, params, connection) {
      validateHarnessProvider(params.harness, connection);
      const record = await withRepository(async (repository) => {
        if (params.instanceId) {
          const existing = await repository.readInstance(
            ownedScope(context),
            params.instanceId,
          );
          if (!existing) throw missing();
          if (
            existing.harness !== params.harness ||
            existing.connectionId !== params.connectionId
          )
            throw conflict();
        }
        return repository.setupInstance(ownedScope(context), params, {
          connectionId: connection.connectionId,
          ownerGeneration: connection.ownerGeneration,
        });
      });
      return unavailableInstance(record);
    },
    async listInstances(context) {
      return (
        await withRepository((repository) =>
          repository.listInstances(ownedScope(context)),
        )
      ).map(unavailableInstance);
    },
    async readInstance(context, instanceId) {
      const record = await readInstance(context, instanceId);
      return record ? unavailableInstance(record) : null;
    },
    async models(context, params) {
      const record = await readInstance(context, params.instanceId);
      if (!record || record.connectionId !== params.connectionId)
        throw missing();
      const connection = await connectionService(
        context,
      ).assertUsableConnection(context, params.connectionId);
      if (!connection) throw missing();
      validateHarnessProvider(record.harness, connection);
      // A catalog is model metadata, not account entitlement or an execution claim.
      const models = builtinProviderRegistry
        .listModels(connection.providerId)
        .map((model) => ({ id: model.modelId, label: model.displayName }));
      return HarnessModelsResponseSchema.parse({
        ...params,
        models,
        availability: models.length ? "available" : "unavailable",
        reason: models.length
          ? "Account and runtime availability are checked before execution"
          : "No supported model catalog is available",
        observedAt: new Date().toISOString(),
      });
    },
    readSelection: (context, params) =>
      withRepository((repository) =>
        repository.readSelection(ownedScope(context), params),
      ),
    readSelectionReceipt: (context, params) =>
      withRepository((repository) =>
        repository.readSelectionReceipt(ownedScope(context), params),
      ),
    async select(context, params) {
      try {
        return await withRepository((repository) =>
          repository.select(ownedScope(context), params),
        );
      } catch (error) {
        if (error instanceof HarnessControlPlaneConflictError) {
          if (error.code === "not_found") throw missing();
          if (error.code === "connection_unavailable")
            throw unavailable("Selected connection is unavailable");
          throw conflict();
        }
        throw error;
      }
    },
  };
}

/** Account admission uses the same durable selection and encrypted authority as setup.
 * Configured instances currently carry no preverified account/host facts, so they
 * cannot produce execution facts. No credential material is sent to a Worker port.
 */
export function createPostgresHarnessAdmissionAccounts(
  env: Env,
): HarnessAdmissionAccountPort {
  const ports = createPostgresHostedHarnessControlPlane(env);
  const contextFor = (
    principal: HarnessAdmissionPrincipal,
  ): HostedHarnessOperationContext => ({
    userId: principal.userId,
    workspaceId: principal.workspaceId,
    environmentId: principal.environmentId,
    correlationId: principal.runAttemptId,
    signal: new AbortController().signal,
  });
  return {
    async resolveForAdmission(principal, expected) {
      const context = contextFor(principal);
      await ports.authorizeEnvironment(context);
      if (
        expected.environmentId !== principal.environmentId ||
        !expected.selection
      )
        throw conflict();
      const saved = await ports.readSelection(context, {
        workspaceId: principal.workspaceId,
        environmentId: principal.environmentId,
        sessionId: principal.sessionId,
        threadId: principal.threadId,
      });
      if (
        saved.revision !== expected.selectionRevision ||
        !saved.selection ||
        saved.selection.harness !== expected.selection.harness ||
        saved.selection.instanceId !== expected.selection.instanceId ||
        saved.selection.connectionId !== expected.selection.connectionId ||
        saved.selection.modelId !== expected.selection.modelId
      )
        throw conflict();
      const instance = await ports.readInstance(
        context,
        expected.selection.instanceId,
      );
      const connection = await ports
        .connectionService(context)
        .assertUsableConnection(context, expected.selection.connectionId);
      if (
        !instance ||
        !connection ||
        instance.status.connectionId !== connection.connectionId ||
        instance.authOwnerGeneration !== connection.ownerGeneration
      )
        throw missing();
      // No self-attestation from a supplied account ID or first provider response.
      throw unavailable(
        "Selected account identity and cloud host execution have not been verified",
      );
    },
    async assertForAttempt(principal, selection) {
      const context = contextFor(principal);
      await ports.authorizeEnvironment(context);
      const connection = await ports
        .connectionService(context)
        .assertUsableConnection(context, selection.connectionId);
      if (
        !connection ||
        connection.ownerGeneration !== selection.authOwnerGeneration
      )
        throw conflict();
      // Existing immutable bindings do not bypass the current host/account gate.
      throw unavailable(
        "Selected account identity and cloud host execution have not been verified",
      );
    },
    async resolveForAttempt(binding) {
      const context = contextFor(binding);
      // Full service enforces admitted immutable binding and route policy before
      // acquisition. This private return is consumed only by the custody owner.
      return ports.connectionService(context).resolveForAttempt(binding);
    },
  };
}

/** Direct env-backed service export for P13's authenticated fourth argument. */
export function createHostedHarnessService(
  env: Env,
): HostedHarnessConnectionService {
  return createHostedHarnessConnectionService(
    createPostgresHostedHarnessControlPlane(env),
  );
}

/** Server route caller: P13 authenticates the principal before invoking methods. */
export function handleHostedHarnessAppServerRequest(
  request: Request,
  env: Env,
  executionContext?: ExecutionContext,
) {
  return AppServerController.request(
    request,
    env,
    executionContext,
    createHostedHarnessService(env),
  );
}
function unavailableInstance(record: ConfiguredInstance): OwnedHarnessInstance {
  const reason =
    record.harness === "codex"
      ? "The pinned Codex API-key route cannot verify the selected account; cloud execution is unavailable"
      : "Cloud harness execution is not available in this environment";
  return {
    authOwnerGeneration: record.authOwnerGeneration,
    accountId: null,
    billingRoute: "api_key",
    status: HarnessInstanceStatusSchema.parse({
      workspaceId: record.workspaceId,
      environmentId: record.environmentId,
      instanceId: record.instanceId,
      harness: record.harness,
      connectionId: record.connectionId,
      accountLabel: null,
      usage: null,
      state: "unavailable",
      reason,
      runtimeVersion: null,
      protocolVersion: null,
      observedAt: new Date().toISOString(),
      capabilities: {
        approvals: false,
        questions: false,
        steer: false,
        resume: false,
        fork: false,
        images: false,
        terminal: false,
        contextTelemetry: false,
        accountQuota: false,
        experimental: true,
      },
    }),
  };
}
function validateHarnessProvider(
  harness: HarnessSetupRequest["harness"],
  connection: HarnessConnectionMetadata,
) {
  if (
    (harness === "codex" && connection.providerId !== "openai") ||
    (harness === "claude" && connection.providerId !== "anthropic")
  )
    throw unavailable("Selected connection does not support this agent");
}
function missing() {
  return new AppServerOperationError(
    404,
    "not_found",
    "Harness resource not found",
  );
}
function unavailable(message: string) {
  return new AppServerOperationError(
    503,
    "server_unavailable",
    message,
    "HARNESS_UNAVAILABLE",
    false,
  );
}
function conflict() {
  return new AppServerOperationError(
    409,
    "conflict",
    "Harness setup or selection changed",
    "HARNESS_CONFLICT",
    false,
  );
}
