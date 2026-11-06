import {
  HarnessModelsResponseSchema, HarnessSelectionResponseSchema, HarnessSetupResponseSchema,
  HarnessStatusResponseSchema,
  type HarnessInstanceStatus, type HarnessModelsRequest, type HarnessModelsResponse,
  type HarnessSelectRequest, type HarnessSelectionReadRequest, type HarnessSelectionResponse,
  type HarnessSetupRequest, type HarnessSetupResponse, type HarnessStatusRequest, type HarnessStatusResponse,
} from "@repo/platform-protocol";
import type { HarnessOperations } from "@legioncode/app-server/server";
import { AppServerOperationError } from "../server.js";
import type { LocalWorkspaceService } from "../local-workspace.js";
import type { LocalThreadService } from "../local-threads.js";

type SelectionStore = Pick<HarnessOperations, "readSelection" | "select">;

/** Accountless local operations over existing grants, configured instances and the
 * canonical selection store. No provider launch, credential read or alternate store.
 */
export class LocalHarnessOperations implements HarnessOperations {
  private selectionStore: SelectionStore | undefined;
  private modelsReader: HarnessOperations["models"] | undefined;
  private statusReader: HarnessOperations["status"] | undefined;
  private setupWriter: HarnessOperations["setup"] | undefined;

  constructor(private readonly options: {
    readonly environmentId: string;
    readonly workspaceService: LocalWorkspaceService;
    readonly threadService: LocalThreadService;
    readonly readInstances: () => readonly HarnessInstanceStatus[];
  }) {}

  /** Trusted local bootstrap only; these adapters must use the existing SQLite
   * writer and a supported safe catalog reader. They are never supplied by HTTP.
   */
  bindServices(services: SelectionStore & Partial<Pick<HarnessOperations, "models" | "status" | "setup">>): void {
    this.selectionStore = services;
    this.modelsReader = services.models?.bind(services);
    this.statusReader = services.status?.bind(services);
    this.setupWriter = services.setup?.bind(services);
  }

  async setup(params: HarnessSetupRequest): Promise<HarnessSetupResponse> {
    await this.authorizeScope(params);
    if (!this.setupWriter) throw new AppServerOperationError(503, "server_unavailable",
      "Local instance setup requires its durable connection and command-receipt store", "LOCAL_HARNESS_SETUP_UNAVAILABLE", false);
    // The same-writer setup owner issues a persisted identity on initial creation,
    // deduplicates the scoped command, and rejects unknown reconnect IDs. Never
    // manufacture a replacement identity in the service or live registry.
    const result = HarnessSetupResponseSchema.parse(await this.setupWriter(params));
    if (result.instance.environmentId !== params.environmentId || result.instance.workspaceId !== params.workspaceId ||
        result.instance.harness !== params.harness || result.instance.connectionId !== params.connectionId ||
        (params.instanceId !== undefined && result.instance.instanceId !== params.instanceId)) {
      throw new AppServerOperationError(503, "server_unavailable", "Local setup receipt does not match the requested connection or instance");
    }
    await this.authorizeScope(params);
    return result;
  }

  async status(params: HarnessStatusRequest): Promise<HarnessStatusResponse> {
    await this.authorizeScope(params);
    const result = HarnessStatusResponseSchema.parse(this.statusReader
      ? await this.statusReader(params)
      : { instances: this.options.readInstances().filter((instance) =>
          instance.environmentId === params.environmentId && instance.workspaceId === params.workspaceId) });
    if (result.instances.some((instance) => instance.environmentId !== params.environmentId || instance.workspaceId !== params.workspaceId)) {
      throw new AppServerOperationError(503, "server_unavailable", "Local instance metadata returned a different workspace");
    }
    const configured = this.options.readInstances();
    if (result.instances.some((instance) => instance.state === "ready" && !configured.some((known) =>
      known.instanceId === instance.instanceId && known.harness === instance.harness &&
      known.connectionId === instance.connectionId && known.workspaceId === instance.workspaceId &&
      known.environmentId === instance.environmentId && known.runtimeVersion === instance.runtimeVersion &&
      known.protocolVersion === instance.protocolVersion))) {
      throw new AppServerOperationError(503, "server_unavailable", "Local instance metadata does not match configured runtime bindings");
    }
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
    const result = await this.requireSelectionStore().readSelection(params);
    await this.authorizeThread(params);
    return this.validateSelectionResponse(params, result);
  }

  async select(params: HarnessSelectRequest): Promise<HarnessSelectionResponse> {
    await this.authorizeThread(params);
    const store = this.requireSelectionStore();
    if (params.selection !== null) {
      const selection = params.selection;
      const instance = await this.requireInstance({ environmentId: params.environmentId, workspaceId: params.workspaceId,
        instanceId: selection.instanceId, connectionId: selection.connectionId });
      if (!instance || instance.harness !== selection.harness) {
        throw new AppServerOperationError(404, "not_found", "The selected local harness reference is not configured");
      }
      // This writes a preference for a future attempt, not a readiness claim or
      // execution admission. Persisted unavailable instances may be selected before
      // their first driver registration; account/model eligibility is checked at admission.
      // Avoid health/catalog I/O before durable command dedupe: a committed retry
      // must not change outcome merely because readiness changed afterward.
    }
    await this.authorizeThread(params);
    // The same-writer owner performs durable revision CAS, grant fencing and command deduplication.
    return this.validateSelectionResponse(params, await store.select(params));
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

  private requireSelectionStore(): SelectionStore {
    if (!this.selectionStore) throw new AppServerOperationError(
      503, "server_unavailable", "Local harness selection persistence is unavailable", "LOCAL_HARNESS_SELECTION_UNAVAILABLE", false,
    );
    return this.selectionStore;
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
