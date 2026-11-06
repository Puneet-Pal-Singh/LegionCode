import {
  HarnessSetupResponseSchema,
  HarnessStatusResponseSchema,
  HarnessModelsResponseSchema,
  HarnessSelectionResponseSchema,
  type HarnessSetupRequest,
  type HarnessStatusRequest,
  type HarnessModelsRequest,
  type HarnessSelectRequest,
  type HarnessSelectionReadRequest,
  type HarnessBillingRoute,
  type HarnessInstanceStatus,
  type HarnessModelsResponse,
  type HarnessSelectionResponse,
} from "@repo/platform-protocol";
import { AppServerOperationError } from "@legioncode/app-server/server";
import type {
  HostedHarnessConnectionService,
  HostedHarnessOperationContext,
} from "../../integration/app-server/HostedHarnessOperations";
import { AppServerController } from "../../controllers/AppServerController";
import type { Env } from "../../types/ai";
import type {
  HarnessConnectionService,
  HarnessConnectionMetadata,
} from "./HarnessConnectionService";

/** Private instance ownership record. Public status intentionally contains no credential generation. */
export interface OwnedHarnessInstance {
  status: HarnessInstanceStatus;
  authOwnerGeneration: number;
  accountId: string | null;
  billingRoute: HarnessBillingRoute;
}
/** P09 supplies observed host facts; P11 supplies durable setup and next-selection
 * CAS/command receipts. These are injected canonical owners, never an in-memory
 * account registry or a second runtime. No Node driver imports enter Brain.
 */
export interface HostedHarnessControlPlane {
  authorizeEnvironment(context: HostedHarnessOperationContext): Promise<void>;
  connectionService(
    context: HostedHarnessOperationContext,
  ): HarnessConnectionService;
  setupInstance(
    context: HostedHarnessOperationContext,
    params: HarnessSetupRequest,
    connection: HarnessConnectionMetadata,
  ): Promise<OwnedHarnessInstance>;
  listInstances(
    context: HostedHarnessOperationContext,
  ): Promise<OwnedHarnessInstance[]>;
  readInstance(
    context: HostedHarnessOperationContext,
    instanceId: string,
  ): Promise<OwnedHarnessInstance | null>;
  models(
    context: HostedHarnessOperationContext,
    params: HarnessModelsRequest,
  ): Promise<HarnessModelsResponse>;
  readSelection(
    context: HostedHarnessOperationContext,
    params: HarnessSelectionReadRequest,
  ): Promise<HarnessSelectionResponse>;
  /** Transactionally compare expectedRevision and deduplicate clientCommandId.
   * Reuse of a command ID with changed content must conflict; admitted bindings
   * are immutable and are never updated by this operation.
   */
  readSelectionReceipt(
    context: HostedHarnessOperationContext,
    params: HarnessSelectRequest,
  ): Promise<HarnessSelectionResponse | null>;
  select(
    context: HostedHarnessOperationContext,
    params: HarnessSelectRequest,
  ): Promise<HarnessSelectionResponse>;
}

export function createHostedHarnessConnectionService(
  ports: HostedHarnessControlPlane,
): HostedHarnessConnectionService {
  const authorize = async (
    context: HostedHarnessOperationContext,
    params: HarnessStatusRequest,
  ) => {
    if (context.signal.aborted) throw unavailable("Harness request cancelled");
    if (
      context.workspaceId !== params.workspaceId ||
      context.environmentId !== params.environmentId
    )
      throw notFound();
    await ports.authorizeEnvironment(context);
  };
  const usable = async (
    context: HostedHarnessOperationContext,
    connectionId: string,
  ) => {
    const connection = await ports
      .connectionService(context)
      .assertUsableConnection(context, connectionId);
    if (!connection) throw notFound();
    if (connection.refreshPending)
      throw unavailable("Selected connection is refreshing");
    return connection;
  };
  const validateInstance = async (
    context: HostedHarnessOperationContext,
    owned: OwnedHarnessInstance,
  ) => {
    const status = owned.status;
    if (
      status.workspaceId !== context.workspaceId ||
      status.environmentId !== context.environmentId ||
      !status.connectionId
    )
      throw notFound();
    const connection = await usable(context, status.connectionId);
    if (connection.ownerGeneration !== owned.authOwnerGeneration)
      throw unavailable("Harness instance requires reauthentication");
    return scopedUsage(owned, connection);
  };
  const instance = async (
    context: HostedHarnessOperationContext,
    instanceId: string,
    connectionId: string,
  ) => {
    const owned = await ports.readInstance(context, instanceId);
    if (
      !owned ||
      owned.status.instanceId !== instanceId ||
      owned.status.connectionId !== connectionId
    )
      throw notFound();
    return validateInstance(context, owned);
  };
  const models = async (
    context: HostedHarnessOperationContext,
    params: HarnessModelsRequest,
  ) => {
    await authorize(context, params);
    const status = await instance(
      context,
      params.instanceId,
      params.connectionId,
    );
    const result = HarnessModelsResponseSchema.parse(
      await ports.models(context, params),
    );
    if (
      result.workspaceId !== params.workspaceId ||
      result.environmentId !== params.environmentId ||
      result.instanceId !== params.instanceId ||
      result.connectionId !== params.connectionId
    )
      throw notFound();
    return result;
  };
  const selection = (
    params: HarnessSelectionReadRequest,
    result: HarnessSelectionResponse,
  ) => {
    const parsed = HarnessSelectionResponseSchema.parse(result);
    if (
      parsed.workspaceId !== params.workspaceId ||
      parsed.environmentId !== params.environmentId ||
      parsed.sessionId !== params.sessionId ||
      parsed.threadId !== params.threadId
    )
      throw notFound();
    return parsed;
  };
  return {
    async setup(context, params) {
      await authorize(context, params);
      const connection = await usable(context, params.connectionId);
      const owned = await ports.setupInstance(context, params, connection);
      const status = await validateInstance(context, owned);
      if (
        (params.instanceId !== undefined &&
          status.instanceId !== params.instanceId) ||
        status.harness !== params.harness ||
        status.connectionId !== params.connectionId
      )
        throw notFound();
      return HarnessSetupResponseSchema.parse({ instance: status });
    },
    async status(context, params) {
      await authorize(context, params);
      const instances: HarnessInstanceStatus[] = [];
      for (const owned of await ports.listInstances(context)) {
        // Revoked/missing credentials cannot leave a cached ready status visible.
        const status = owned.status;
        if (
          status.workspaceId !== context.workspaceId ||
          status.environmentId !== context.environmentId
        )
          throw notFound();
        const connection = status.connectionId
          ? await ports
              .connectionService(context)
              .get(context, status.connectionId)
          : null;
        if (
          !connection ||
          connection.status !== "connected" ||
          connection.ownerGeneration !== owned.authOwnerGeneration
        ) {
          instances.push({
            ...status,
            state: "reauthentication_required",
            accountLabel: null,
            usage: null,
            reason: "Selected connection is unavailable",
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
          });
        } else if (connection.refreshPending) {
          instances.push({
            ...scopedUsage(owned, connection),
            state: "connecting",
            reason: "Selected connection is refreshing",
          });
        } else {
          await usable(context, connection.connectionId);
          instances.push(scopedUsage(owned, connection));
        }
      }
      return HarnessStatusResponseSchema.parse({ instances });
    },
    models,
    async readSelection(context, params) {
      await authorize(context, params);
      return selection(params, await ports.readSelection(context, params));
    },
    async select(context, params) {
      await authorize(context, params);
      const receipt = await ports.readSelectionReceipt(context, params);
      if (receipt) return selection(params, receipt);
      if (params.selection) {
        const chosen = params.selection;
        const status = await instance(
          context,
          chosen.instanceId,
          chosen.connectionId,
        );
        if (status.harness !== chosen.harness)
          throw unavailable("Selected harness does not match the instance");
        const catalog = await models(context, {
          workspaceId: params.workspaceId,
          environmentId: params.environmentId,
          instanceId: chosen.instanceId,
          connectionId: chosen.connectionId,
        });
        if (!catalog.models.some((model) => model.id === chosen.modelId))
          throw unavailable("Selected harness model is unavailable");
      }
      return selection(params, await ports.select(context, params));
    },
  };
}

/** Concrete fourth-argument handoff to P13's existing authenticated dispatcher. */
export function createHostedHarnessRequestHandler(
  ports: HostedHarnessControlPlane,
) {
  const service = createHostedHarnessConnectionService(ports);
  return (request: Request, env: Env, executionContext?: ExecutionContext) =>
    AppServerController.request(request, env, executionContext, service);
}
function notFound(): AppServerOperationError {
  return new AppServerOperationError(
    404,
    "not_found",
    "Harness connection or instance not found",
  );
}
function unavailable(message: string): AppServerOperationError {
  return new AppServerOperationError(
    503,
    "server_unavailable",
    message,
    "HARNESS_UNAVAILABLE",
    false,
  );
}

/** Only observations from the frozen account/route/owner binding reach clients.
 * Quota freshness and nullable measurements remain the upstream owner's facts.
 */
function scopedUsage(
  owned: OwnedHarnessInstance,
  connection: HarnessConnectionMetadata,
): HarnessInstanceStatus {
  const status = owned.status;
  const usage = status.usage;
  const matches =
    usage !== null &&
    owned.accountId !== null &&
    usage.accountId === owned.accountId &&
    usage.connectionId === connection.connectionId &&
    usage.environmentId === status.environmentId &&
    usage.authOwnerGeneration === connection.ownerGeneration &&
    usage.billingRoute === owned.billingRoute &&
    (connection.kind !== "api_key" || usage.billingRoute === "api_key");
  return { ...status, usage: matches ? usage : null };
}
