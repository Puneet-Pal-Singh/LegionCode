import {
  HarnessModelsResponseSchema, HarnessSelectionResponseSchema, HarnessSetupResponseSchema,
  HarnessStatusResponseSchema,
  type HarnessInstanceStatus, type HarnessModelsRequest, type HarnessModelsResponse,
  type HarnessSelectRequest, type HarnessSelectionReadRequest, type HarnessSelectionResponse,
  type HarnessSetupRequest, type HarnessSetupResponse, type HarnessStatusRequest, type HarnessStatusResponse,
} from "@repo/platform-protocol";
import type { HarnessOperations } from "@legioncode/app-server/server";
import { LocalHarnessControlPlaneError, type LocalHarnessControlPlanePort } from "@repo/event-store";
import { AppServerOperationError } from "../server.js";
import type { LocalWorkspaceService } from "../local-workspace.js";
import type { LocalThreadService } from "../local-threads.js";

export type { LocalHarnessControlPlanePort } from "@repo/event-store";

type DiscoveryServices = Partial<Pick<HarnessOperations, "models" | "status">>;

/** Accountless local operations over existing grants, configured instances and the
 * canonical selection store. No provider launch, credential read or alternate store.
 */
export class LocalHarnessOperations implements HarnessOperations {
  private selectionQueue: Promise<void> = Promise.resolve();
  private modelsReader: HarnessOperations["models"] | undefined;
  private statusReader: HarnessOperations["status"] | undefined;
  private discoveryBound = false;

  constructor(private readonly options: {
    readonly environmentId: string;
    readonly workspaceService: LocalWorkspaceService;
    readonly threadService: LocalThreadService;
    readonly controlPlane: LocalHarnessControlPlanePort;
  }) {}

  /** Trusted discovery only. Bootstrap cannot replace the canonical setup,
   * instance identities, selection CAS or command-receipt authority.
   */
  bindServices(services: DiscoveryServices): void {
    if (this.discoveryBound) throw new Error("Local harness discovery services are already bound");
    this.modelsReader = services.models?.bind(services);
    this.statusReader = services.status?.bind(services);
    this.discoveryBound = true;
  }

  async setup(params: HarnessSetupRequest): Promise<HarnessSetupResponse> {
    await this.authorizeScope(params);
    // The same-writer setup owner issues a persisted identity on initial creation,
    // deduplicates the scoped command, and rejects unknown reconnect IDs. Never
    // manufacture a replacement identity in the service or live registry.
    const result = HarnessSetupResponseSchema.parse(await this.controlPlaneOperation(() => this.options.controlPlane.setup(params)));
    if (result.instance.environmentId !== params.environmentId || result.instance.workspaceId !== params.workspaceId ||
        result.instance.harness !== params.harness || result.instance.connectionId !== params.connectionId ||
        (params.instanceId !== undefined && result.instance.instanceId !== params.instanceId)) {
      throw new AppServerOperationError(503, "server_unavailable", "Local setup receipt does not match the requested connection or instance");
    }
    this.assertStoredUnavailable([result.instance]);
    await this.authorizeScope(params);
    return result;
  }

  async status(params: HarnessStatusRequest): Promise<HarnessStatusResponse> {
    await this.authorizeScope(params);
    const stored = await this.readStoredStatus(params);
    if (!this.statusReader) {
      await this.authorizeScope(params);
      return stored;
    }
    const observed = HarnessStatusResponseSchema.parse(await this.statusReader(params));
    const seen = new Set<string>();
    for (const instance of observed.instances) {
      const known = stored.instances.find((candidate) => this.sameInstance(candidate, instance));
      if (!known || seen.has(instance.instanceId) ||
          (instance.state === "ready" && (!instance.runtimeVersion || !instance.protocolVersion))) {
        throw new AppServerOperationError(503, "server_unavailable", "Local health does not match a durable configured instance");
      }
      seen.add(instance.instanceId);
    }
    const result = { instances: stored.instances.map((instance) =>
      observed.instances.find((candidate) => this.sameInstance(instance, candidate)) ?? instance) };
    await this.authorizeScope(params);
    return result;
  }

  async models(params: HarnessModelsRequest): Promise<HarnessModelsResponse> {
    await this.authorizeScope(params);
    await this.requireInstance(params);
    if (!this.modelsReader) return HarnessModelsResponseSchema.parse({
      ...params, models: [], availability: "unavailable",
      reason: "A supported local harness model catalog is not connected", observedAt: new Date().toISOString(),
    });
    const result = HarnessModelsResponseSchema.parse(await this.modelsReader(params));
    if (result.environmentId !== params.environmentId || result.workspaceId !== params.workspaceId ||
        result.instanceId !== params.instanceId || result.connectionId !== params.connectionId) {
      throw new AppServerOperationError(503, "server_unavailable", "Local model catalog returned a different connection");
    }
    await this.authorizeScope(params);
    return result;
  }

  async readSelection(params: HarnessSelectionReadRequest): Promise<HarnessSelectionResponse> {
    await this.authorizeThread(params);
    const result = await this.controlPlaneOperation(() => this.options.controlPlane.readSelection(params));
    await this.authorizeThread(params);
    return this.validateSelectionResponse(params, result);
  }

  async select(params: HarnessSelectRequest): Promise<HarnessSelectionResponse> {
    return this.serializeSelection(() => this.selectWithin(params));
  }

  /** Freeze admission intent while local selection commands are excluded. The
   * process owns the exclusive SQLite writer; the store still owns durable CAS
   * and receipts. A picker change can only affect a later admitted attempt.
   */
  withSelection<T>(params: HarnessSelectionReadRequest,
    admit: (saved: HarnessSelectionResponse) => Promise<T>): Promise<T> {
    return this.serializeSelection(async () => admit(await this.readSelection(params)));
  }

  private serializeSelection<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.selectionQueue.then(operation);
    this.selectionQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async selectWithin(params: HarnessSelectRequest): Promise<HarnessSelectionResponse> {
    await this.authorizeThread(params);
    // The same writer owns command dedupe, revision CAS and configured-instance
    // eligibility together with grant/Thread checks. Do not put health/catalog
    // reads or a competing instance check in front of its durable receipt.
    const result = await this.controlPlaneOperation(() => this.options.controlPlane.select(params));
    await this.authorizeThread(params);
    return this.validateSelectionResponse(params, result);
  }

  private async authorizeScope(params: HarnessStatusRequest): Promise<void> {
    if (params.environmentId !== this.options.environmentId) {
      throw new AppServerOperationError(403, "unauthorized", "This harness operation belongs to a different environment");
    }
    const workspace = await this.options.workspaceService.getCurrent();
    if (!workspace || workspace.readiness !== "ready" || workspace.workspaceId !== params.workspaceId) {
      throw new AppServerOperationError(403, "unauthorized", "The local harness workspace is not granted");
    }
    await this.options.workspaceService.requireExecutionGrant(workspace.workspaceId);
  }

  private async authorizeThread(params: HarnessSelectionReadRequest): Promise<void> {
    await this.authorizeScope(params);
    const thread = await this.options.threadService.get(params.threadId);
    // A local Thread is the local conversation authority; no hosted Session is created.
    if (thread.status !== "active" || thread.workspaceId !== params.workspaceId || params.sessionId !== thread.id) {
      throw new AppServerOperationError(403, "unauthorized", "The local harness conversation does not match the grant");
    }
  }

  private async requireInstance(params: HarnessModelsRequest): Promise<HarnessInstanceStatus> {
    const statuses = await this.status({ environmentId: params.environmentId, workspaceId: params.workspaceId });
    const instance = statuses.instances.find((candidate) =>
      candidate.environmentId === params.environmentId && candidate.workspaceId === params.workspaceId &&
      candidate.instanceId === params.instanceId && candidate.connectionId === params.connectionId);
    if (!instance) throw new AppServerOperationError(404, "not_found", "Local harness instance or connection was not configured");
    return instance;
  }

  private async readStoredStatus(params: HarnessStatusRequest): Promise<HarnessStatusResponse> {
    const result = HarnessStatusResponseSchema.parse(await this.controlPlaneOperation(() => this.options.controlPlane.status({
      environmentId: params.environmentId, workspaceId: params.workspaceId,
    })));
    if (result.instances.some((instance) => instance.environmentId !== params.environmentId || instance.workspaceId !== params.workspaceId)) {
      throw new AppServerOperationError(503, "server_unavailable", "Local instance metadata returned a different workspace");
    }
    this.assertStoredUnavailable(result.instances);
    return result;
  }

  private assertStoredUnavailable(instances: readonly HarnessInstanceStatus[]): void {
    if (instances.some((instance) => instance.state === "ready" || instance.usage !== null ||
        Object.values(instance.capabilities).some(Boolean))) {
      throw new AppServerOperationError(503, "server_unavailable", "Stored local configuration cannot attest runtime readiness or capabilities");
    }
  }

  private sameInstance(left: HarnessInstanceStatus, right: HarnessInstanceStatus): boolean {
    return left.environmentId === right.environmentId && left.workspaceId === right.workspaceId &&
      left.instanceId === right.instanceId && left.connectionId === right.connectionId && left.harness === right.harness;
  }

  private async controlPlaneOperation<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof LocalHarnessControlPlaneError) {
        if (error.code === "not_found") {
          throw new AppServerOperationError(404, "not_found", "The local harness scope or configured reference is unavailable");
        }
        throw new AppServerOperationError(409, "invalid_request", "The local harness command conflicts with canonical configuration or selection revision");
      }
      throw error;
    }
  }

  private validateSelectionResponse(params: HarnessSelectionReadRequest, input: HarnessSelectionResponse): HarnessSelectionResponse {
    const result = HarnessSelectionResponseSchema.parse(input);
    if (result.environmentId !== params.environmentId || result.workspaceId !== params.workspaceId ||
        result.threadId !== params.threadId || result.sessionId !== params.sessionId) {
      throw new AppServerOperationError(503, "server_unavailable", "Local selection persistence returned a different conversation");
    }
    return result;
  }
}
