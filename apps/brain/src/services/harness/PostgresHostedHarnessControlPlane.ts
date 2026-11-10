import {
  AppServerEnvironmentIdSchema,
  HarnessModelsResponseSchema,
  HarnessInstanceStatusSchema,
  HarnessSelectionSchema, RunAttemptIdSchema, ThreadIdSchema, TurnIdSchema,
  InterruptTurnRequestSchema,
  type HarnessSetupRequest,
} from "@repo/platform-protocol";
import {
  PostgresHarnessControlPlaneRepository,
  PostgresHarnessBindingRepository,
  PostgresHarnessAdmissionBindingPort,
  PostgresTurnAdmissionRepository,
  PostgresTaskWorkspaceRepository,
  StoredHarnessAttachmentSchema,
  type SqlClient,
  HarnessControlPlaneConflictError,
} from "@repo/persistence";
import { SecureHarnessExecutionPort } from "../../runtime/SecureHarnessExecutionPort";
import { SecureExecutionSessionClient } from "../secure-execution/SecureExecutionSessionClient";
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
import { authorizeHostedHarnessAttempt } from "./HostedHarnessAttemptAuthority";

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
    transaction?: SqlClient,
  ) => {
    const configured = AppServerEnvironmentIdSchema.safeParse(
      (env as Env & { APP_SERVER_ENVIRONMENT_ID?: string })
        .APP_SERVER_ENVIRONMENT_ID,
    );
    if (!configured.success)
      throw unavailable("Hosted environment identity is not configured");
    if (context.environmentId !== configured.data) throw missing();
    // The transactional attempt helper below locks the owned active workspace
    // and session on this supplied client, rather than consulting another pool.
    if (transaction) return;
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
        signal: context.signal,
        async authorizeAttempt(binding, transaction) {
          await authorizeEnvironment(context, transaction);
          const selected = await authorizeHostedHarnessAttempt(
            env,
            context,
            binding,
            transaction,
          );
          validateHarnessProvider(selected.harness, binding);
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
          // The revoked credential row is the durable fence. Enumerate canonical
          // bindings, including startup/recovery and archived/inactive sessions;
          // a session's current activeRunId is not the process ownership ledger.
          const ownership = await withBrainPersistenceRepository(
            env,
            undefined,
            (client) => client,
            async (client) => {
              const revoked = await client.query(
                "SELECT id FROM provider_credentials WHERE user_id::text=$1 AND id::text=$2 AND status='revoked' AND auth_owner_generation >= $3",
                [scope.userId, connectionId, ownerGeneration],
              );
              if (!revoked.rows[0]) throw missing();
              const candidates = await client.query<{ turn_id: string }>(
                `SELECT a.turn_id FROM canonical_turn_admissions a
                 JOIN sessions s ON s.id=a.session_id
                 LEFT JOIN harness_bindings b ON a.turn_id=b.turn_id AND a.run_attempt_id=b.run_attempt_id AND b.user_id=$1
                 WHERE s.user_id::text=$1 AND a.admission_state='admitted'
                   AND (a.execution_claim_id IS NOT NULL OR b.turn_id IS NOT NULL)
                   AND ((b.selection_json->>'selectionJson')::jsonb->>'connectionId'=$2
                     OR a.harness_admission_receipt_json->'capture'->'selection'->>'connectionId'=$2)
                 ORDER BY a.turn_id LIMIT 1001`,
                [scope.userId, connectionId],
              );
              if (candidates.rows.length > 1000)
                throw unavailable(
                  "Credential revoked; process fence capacity exceeded",
                );
              const admissions = new PostgresTurnAdmissionRepository(client);
              const bindings = new PostgresHarnessBindingRepository(client);
              const authority = new PostgresHarnessAdmissionBindingPort(client);
              const targets = [];
              const openingTargets = [];
              let ambiguousOwnership = false;
              for (const { turn_id } of candidates.rows) {
                const admission = await admissions.getByTurnId(turn_id);
                if (
                  !admission ||
                  admission.userId !== scope.userId ||
                  admission.state !== "admitted"
                )
                  continue;
                if (
                  !admission.workspaceId ||
                  !admission.harnessSelection?.selection ||
                  !admission.requestFingerprint
                )
                  throw missing();
                const stored = await bindings.read({
                  userId: scope.userId,
                  turnId: admission.turnId,
                  runAttemptId: admission.runAttemptId,
                });
                if (!stored) {
                  // A claimed opening without its binding/learned session has an
                  // unknown external outcome. Never fabricate a session to stop it.
                  ambiguousOwnership = true;
                  continue;
                }
                const selection = HarnessSelectionSchema.parse(
                  JSON.parse(stored.selection.selectionJson),
                );
                const selected = await authority.lookupImmutable(
                  {
                    userId: scope.userId,
                    workspaceId: admission.workspaceId,
                    environmentId: selection.environmentId,
                    sessionId: admission.sessionId,
                    threadId: admission.threadId,
                    turnId: admission.turnId,
                    runAttemptId: admission.runAttemptId,
                    runId: admission.runId,
                  },
                  admission.harnessSelection,
                  admission.requestFingerprint,
                );
                if (
                  !selected ||
                  selected.connectionId !== connectionId ||
                  selected.authOwnerGeneration >= ownerGeneration
                )
                  continue;
                const opening = await bindings.readOpening({userId: scope.userId, turnId: admission.turnId, runAttemptId: admission.runAttemptId});
                if (opening && opening.phase !== "retired" && opening.phase !== "cancelled_before_dispatch") {
                  const checkout = await new PostgresTaskWorkspaceRepository(client).getByRunAttemptId(RunAttemptIdSchema.parse(admission.runAttemptId));
                  const intent = opening.intent;
                  if (!checkout || checkout.workspaceId !== selected.workspaceId || checkout.threadId !== admission.threadId ||
                      checkout.turnId !== admission.turnId || intent.executionLease.kind !== "cloud" ||
                      intent.executionLease.leaseId !== checkout.leaseId || intent.executionLease.sandboxId !== checkout.sandboxId ||
                      intent.executionLease.generation !== checkout.generation || intent.instanceId !== selected.instanceId ||
                      intent.authOwnerGeneration !== selected.authOwnerGeneration) ambiguousOwnership = true;
                  else openingTargets.push({admission, selected, opening, checkout});
                }
                const generations = await client.query<{
                  process_generation: string;
                  origin_json: unknown;
                }>(
                  "SELECT process_generation,origin_json FROM harness_process_generations WHERE turn_id=$1 ORDER BY process_generation LIMIT 129",
                  [admission.turnId],
                );
                if (generations.rows.length > 128)
                  throw unavailable(
                    "Credential revoked; process generation capacity exceeded",
                  );
                let attachedGenerationFound = stored.attachment === null;
                for (const generation of generations.rows) {
                  const origin = StoredHarnessAttachmentSchema.parse(
                    typeof generation.origin_json === "string"
                      ? JSON.parse(generation.origin_json)
                      : generation.origin_json,
                  );
                  if (
                    origin.processGeneration !==
                      generation.process_generation ||
                    origin.instanceId !== selected.instanceId ||
                    origin.authOwnerGeneration !== selected.authOwnerGeneration
                  )
                    throw missing();
                  if (
                    stored.attachment?.processGeneration ===
                      origin.processGeneration &&
                    stored.attachment.externalSessionId ===
                      origin.externalSessionId
                  )
                    attachedGenerationFound = true;
                }
                if (!attachedGenerationFound)
                  throw unavailable(
                    "Credential revoked; persisted process origin is incomplete",
                  );
                // Address the canonical attempt even before attachment/startup.
                // Runtime/host proof that every generation quiesces remains a
                // release gate; enumeration is not physical termination evidence.
                if (admission.executionState === "settled") {
                  // A terminal admission cannot prove its attached processes or
                  // ambiguous opening are physically quiescent/released.
                  ambiguousOwnership = true;
                } else {
                  targets.push(admission);
                }
              }
              return { targets, openingTargets, ambiguousOwnership };
            },
          );
          const { targets: active, openingTargets } = ownership;
          let ambiguousOwnership = ownership.ambiguousOwnership;
          for (const {admission, selected, opening, checkout} of openingTargets) {
            try {
              // Borrow only the exact persisted session. Never acquire/resume,
              // replace a sandbox, or reauthenticate a revoked provider here.
              const session = await new SecureExecutionSessionClient(env, admission.sessionId, admission.runId,
                {runId: admission.runId, threadId: admission.threadId, turnId: admission.turnId,
                  runAttemptId: admission.runAttemptId, workspaceId: selected.workspaceId, root: checkout.filesystemRoot},
                {secureSessionId: checkout.secureSessionId, leaseId: checkout.leaseId, sandboxId: checkout.sandboxId,
                  generation: checkout.generation}).borrowOriginal();
              const port = new SecureHarnessExecutionPort(env, {userId: admission.userId, workspaceId: selected.workspaceId,
                sessionId: admission.sessionId, runId: admission.runId, threadId: ThreadIdSchema.parse(admission.threadId),
                turnId: TurnIdSchema.parse(admission.turnId), runAttemptId: RunAttemptIdSchema.parse(admission.runAttemptId)});
              port.bindCleanupSession(session);
              await port.fenceOpening({userId: admission.userId, workspaceId: selected.workspaceId,
                environmentId: selected.environmentId, turnId: TurnIdSchema.parse(admission.turnId), runAttemptId: RunAttemptIdSchema.parse(admission.runAttemptId),
                instanceId: selected.instanceId, openingRef: opening.intent.openingRef,
                commandFingerprint: opening.intent.commandFingerprint, processGeneration: opening.intent.processGeneration,
                executionLease: opening.intent.executionLease});
              // Current host result is explicitly unknown. It cannot retire a
              // durable opening, release custody, or certify descendants.
              ambiguousOwnership = true;
            } catch { ambiguousOwnership = true; }
          }
          // No credential/admission locks or live SQL port cross into RPC work.
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
            await commands.interruptTurn(params);
            // Neither accepted nor status=settled proves physical quiescence.
          }
          if (active.length > 0 || ambiguousOwnership)
            throw unavailable(
              "Credential revoked; physical process cleanup is pending",
            );
          // Tombstone and existing leases remain with their canonical owners.
          // This API has no physical/observation proof port to discharge cleanup.
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
  connection: Pick<HarnessConnectionMetadata, "providerId">,
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
