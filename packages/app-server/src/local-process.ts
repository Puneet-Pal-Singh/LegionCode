import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { LocalPersistence } from "@repo/event-store/local";
import type { ReplayLifecycleEventsRequest, GetTurnDiffRequest } from "@repo/platform-protocol";
import {
  AppServerRequestSchema,
  LocalTurnStartParamsSchema,
  LOCAL_APP_SERVER_IMAGE_REQUEST_HEADER,
  MAX_LOCAL_APP_SERVER_IMAGE_REQUEST_BYTES,
  MAX_LOCAL_APP_SERVER_REQUEST_BYTES,
  assertLocalAppServerRequestBudget,
  isLocalAppServerImageRequest,
} from "./protocol.js";
import type { AppServerComposition } from "./server.js";
import { AppServerOperationError, handleAppServerHttpRequest, validateAppServerHttpBoundary } from "./server.js";
import { LocalWorkspaceService, type LocalWorkspaceServiceOptions } from "./local-workspace.js";
import { DefaultGitService } from "@repo/git-service";
import { createNodeGitExecutor } from "./local-node-git-executor.js";
import type { VerifiedMacGitExecution, VerifiedMacGitOptions } from "./local-mac-git-execution.js";
import { LocalThreadNotFoundError, LocalThreadService } from "./local-threads.js";
import { LocalProviderService, ProviderConfigurationSchema } from "./local-providers.js";
import type { LocalProviderModelCatalog } from "./local-provider-model-catalog.js";

import { LocalHarnessComposition, LocalHarnessRecoveryError, type LocalHarnessBootstrap } from "./harness/LocalHarnessComposition.js";
import { LocalTurnService as NativeLocalTurnService, type LocalTurnRuntime } from "./local-turns.js";
import { reconcileLostLocalTurns } from "./local-turn-recovery.js";
import { attachLocalServerShutdown, combineLocalShutdownOwners, type LocalShutdownOwner } from "./local-server-shutdown.js";
import { LocalProviderPreferences } from "./local-provider-preferences.js";
import { LocalTurnArtifactReads } from "./local-turn-artifact-reads.js";
import { LocalChatMediaStore } from "./local-chat-media-store.js";
import { LocalChatMediaReads } from "./local-chat-media-reads.js";
import type { LocalTurnMediaPort } from "./local-turn-media.js";

export type LocalAppServerStartConfig = {
  credential: string;
  serverVersion: string;
  storageDirectory: string;
  protectedHostRoots?: readonly string[];
  nativeFilesystemHelperPath?: string;
  nativeProcessHelperPath?: string;
};

export type LocalAppServerMessage =
  | { type: "ready"; baseUrl: string }
  | { type: "fatal" };

export type LocalAppServerParentPort = {
  postMessage(message: LocalAppServerMessage): void;
};

export type LocalAppServerCompositionOptions = {
  harnessBootstrap?: LocalHarnessBootstrap;
  providerModelCatalog?: LocalProviderModelCatalog;
  createMetadataInspector?: LocalWorkspaceServiceOptions["createMetadataInspector"];
  createProbeExecution?: (authority: Pick<VerifiedMacGitOptions, "probeRoot" | "withRootAuthority">) => Promise<VerifiedMacGitExecution>;
  createWorkspaceFilesService?(workspaces: LocalWorkspaceService): NonNullable<AppServerComposition["localWorkspaceFilesService"]>;
  createTurnRuntime?(persistence: Pick<LocalPersistence, "turnAdmissions" | "lifecycleEvents" | "turnArtifacts">, media?: LocalTurnMediaPort): LocalTurnRuntime;
  createArtifactCommitService?(input: {
    persistence: Pick<LocalPersistence, "turnAdmissions" | "lifecycleEvents" | "turnArtifacts" | "workspaceGrants">;
    workspaces: LocalWorkspaceService;
    reads: LocalTurnArtifactReads;
  }): NonNullable<AppServerComposition["localTurnArtifactCommitService"]> & LocalShutdownOwner;
};

export type LocalWorkspaceFilesCompositionOptions = LocalAppServerCompositionOptions;

export async function createLocalAppServer(config: LocalAppServerStartConfig, options?: LocalAppServerCompositionOptions) {
  if (options?.createWorkspaceFilesService && !config.protectedHostRoots?.length) {
    throw new Error("Workspace file queries require trusted protected host roots");
  }
  const persistence = new LocalPersistence({ storageDirectory: config.storageDirectory });
  try {
    const createProbeExecution = options?.createProbeExecution;
    const workspaceService = new LocalWorkspaceService({
      workspaceGrants: persistence.workspaceGrants,
      createMetadataInspector: options?.createMetadataInspector,
      createProbeService: createProbeExecution ? async (authority) => {
        const macExecution = await createProbeExecution(authority);
        const git = new DefaultGitService(createNodeGitExecutor({ macExecution }));
        return { probeRepository: (input) => git.probeRepository(input) };
      } : undefined,
      protectedHostRoots: [
        config.storageDirectory, ...(config.protectedHostRoots ?? []),
        ...(config.nativeFilesystemHelperPath ? [config.nativeFilesystemHelperPath] : []),
        ...(config.nativeProcessHelperPath ? [config.nativeProcessHelperPath] : []),
      ],
    });
    const threadService = new LocalThreadService({
      events: persistence.events,
      getWorkspace: () => workspaceService.getAuthorizedCurrent(),
      readRuntimeSummary: persistence.turnAdmissions.readThreadSummary,
    });
    const providerService = new LocalProviderService({
      selectionStore: persistence.providerSelection,
      modelCatalog: options?.providerModelCatalog,
    });
    const harness = new LocalHarnessComposition(persistence, {
      workspaceService, threadService, providerService,
    }, config.storageDirectory);
    if (options?.harnessBootstrap) harness.bootstrap(options.harnessBootstrap);
    const providerPreferences = new LocalProviderPreferences({
      getWorkspace: () => workspaceService.getAuthorizedCurrent(),
      store: persistence.providerPreferences,
      providers: providerService,
    });
    const workspaceFilesService = options?.createWorkspaceFilesService?.(workspaceService);
    const media = new LocalChatMediaStore({
      storageDirectory: config.storageDirectory,
      lookupAdmission: (scope) => persistence.turnAdmissions.getByTurn(scope.turnId),
    });
    const runtime = options?.createTurnRuntime?.(persistence, media);
    const [, delegatedRecovery] = await Promise.all([
      runtime ? reconcileLostLocalTurns(persistence, runtime) : Promise.resolve(),
      harness.turnService.initialize(),
    ]);
    if (delegatedRecovery.status !== "ready") throw new LocalHarnessRecoveryError(delegatedRecovery.retainedTurnIds);
    const nativeTurnService = runtime ? new NativeLocalTurnService({
      persistence,
      workspaces: workspaceService,
      threads: threadService,
      providers: providerService,
      runtime,
      media,
    }) : undefined;
    const turnService = createLocalSavedOwnerRouting(harness.turnService, nativeTurnService, persistence);
    const artifactReads = nativeTurnService ? new LocalTurnArtifactReads({
      turns: turnService,
      persistence,
    }) : undefined;
    const imageReads = nativeTurnService ? new LocalChatMediaReads({ turns: turnService, store: media }) : undefined;
    const artifactCommits = artifactReads ? options?.createArtifactCommitService?.({
      persistence, workspaces: workspaceService, reads: artifactReads,
    }) : undefined;
    const server = createServer((request, response) => {
      void handleRequest(request, response, config, workspaceService, threadService, providerService, persistence, workspaceFilesService, turnService, providerPreferences, artifactReads, imageReads, artifactCommits, harness);
    });
    return attachLocalServerShutdown(
      server, persistence, combineLocalShutdownOwners(nativeTurnService, artifactCommits, {
        get hasActiveExecutions() { return harness.turnService.hasActiveExecutions; },
        async shutdown() { await harness.turnService.shutdown(); },
      }),
      () => workspaceService.hasUnsettledResources,
    );
  } catch (error) {
    persistence.close();
    throw error;
  }
}

function createLocalSavedOwnerRouting(
  delegated: LocalHarnessComposition["turnService"],
  native: NativeLocalTurnService | undefined,
  persistence: Pick<LocalPersistence, "turnAdmissions">,
) {
  const requireNative = () => {
    if (!native) throw new AppServerOperationError(503, "server_unavailable", "Native local execution is not configured", undefined, false);
    return native;
  };
  const saved = async (turnId: Parameters<typeof delegated.savedTurnBackend>[0]) =>
    (await delegated.savedTurnBackend(turnId)) === "delegated" ? delegated : requireNative();
  return {
    ...(native ? { getConfigurationOptions: () => native.getConfigurationOptions() } : {}),
    startTurn: async (params: Parameters<NativeLocalTurnService["startTurn"]>[0]) => {
      const request = LocalTurnStartParamsSchema.parse(params);
      const previous = await persistence.turnAdmissions.findByRequest(request.threadId, request.clientRequestId);
      if (previous && (await delegated.savedTurnBackend(previous.turn.id)) !== "native")
        throw new AppServerOperationError(409, "invalid_request", "The saved request belongs to the delegated backend", undefined, false);
      return requireNative().startTurn(request);
    },
    getTurn: async (turnId: Parameters<typeof delegated.getTurn>[0]) => (await saved(turnId)).getTurn(turnId),
    readHistory: (params: Parameters<typeof delegated.readHistory>[0]) => (native ?? delegated).readHistory(params),
    interruptTurn: async (params: Parameters<typeof delegated.interruptTurn>[0]) => (await saved(params.turnId)).interruptTurn(params),
    submitLifecycleApproval: async (params: Parameters<typeof delegated.submitLifecycleApproval>[0]) =>
      (await saved(params.turnId)).submitLifecycleApproval(params),
    submitUserInputResponse: async (params: Parameters<typeof delegated.submitUserInputResponse>[0]) => {
      if ((await delegated.savedTurnBackend(params.turnId)) !== "delegated")
        throw new AppServerOperationError(503, "server_unavailable", "Native question responses are unavailable", undefined, false);
      return delegated.submitUserInputResponse(params);
    },
  };
}

export function runLocalAppServerProcess(
  parentPort: LocalAppServerParentPort,
  config: LocalAppServerStartConfig,
  options?: LocalWorkspaceFilesCompositionOptions,
): void {
  let server: ReturnType<typeof createLocalAppServer>;
  try {
    server = createLocalAppServer(config, options);
  } catch {
    parentPort.postMessage({ type: "fatal" });
    process.exit(1);
    return;
  }
  server.once("error", () => {
    parentPort.postMessage({ type: "fatal" });
    server.close(() => process.exit(1));
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      parentPort.postMessage({ type: "fatal" });
      server.close(() => process.exit(1));
      return;
    }
    parentPort.postMessage({
      type: "ready",
      baseUrl: `http://127.0.0.1:${address.port}`,
    });
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: LocalAppServerStartConfig,
  workspaceService: LocalWorkspaceService,
  threadService: LocalThreadService,
  providerService: LocalProviderService,
  persistence: LocalPersistence,
  workspaceFilesService?: AppServerComposition["localWorkspaceFilesService"],
  turnService?: ReturnType<typeof createLocalSavedOwnerRouting>,
  providerPreferences?: LocalProviderPreferences,
  artifactReads?: LocalTurnArtifactReads,
  imageReads?: LocalChatMediaReads,
  artifactCommits?: AppServerComposition["localTurnArtifactCommitService"],
  harness?: LocalHarnessComposition,
): Promise<void> {
  const baseInput = {
    method: request.method ?? "",
    path: request.url ?? "/",
    host: request.headers.host,
    origin: request.headers.origin,
    authorization: request.headers.authorization,
    contentType: request.headers["content-type"],
  };
  const readSavedDiff = async (params: GetTurnDiffRequest) => {
    if (harness && (await harness.turnService.savedTurnBackend(params.turnId)) === "delegated")
      return harness.turnService.getTurnDiff(params);
    if (!artifactReads) throw new AppServerOperationError(503, "server_unavailable", "Native saved review is unavailable", undefined, false);
    return artifactReads.getTurnDiff(params);
  };
  const composition = {
    environment: "local" as const,
    serverId: "legioncode-local",
    serverVersion: config.serverVersion,
    credential: config.credential,
    workspaceService,
    localWorkspaceFilesService: workspaceFilesService,
    localTurnService: turnService,
    localProviderPreferenceService: providerPreferences,
    localTurnArtifactReadsService: { getTurnDiff: readSavedDiff },
    localChatMediaService: imageReads,
    localTurnArtifactCommitService: artifactCommits ? {
      commitTurnArtifact: async (params: Parameters<NonNullable<typeof artifactCommits>["commitTurnArtifact"]>[0]) => {
        if (harness && (await harness.turnService.savedTurnBackend(params.turnId)) === "delegated")
          throw new AppServerOperationError(503, "server_unavailable", "Delegated saved commits require their enforced writer authority", undefined, false);
        return artifactCommits.commitTurnArtifact(params);
      },
    } : undefined,
    environmentId: persistence.environmentId,
    harnessOperations: harness?.harnessOperations,
    hostedChatSubmissionService: harness?.turnService,
    hostedLifecycleOperationsService: turnService ? {
      replayLifecycleEvents: (params: ReplayLifecycleEventsRequest) => replayLocalLifecycle(persistence, threadService, params),
      getTurnDiff: readSavedDiff,
      submitLifecycleApproval: turnService.submitLifecycleApproval,
      submitUserInputResponse: turnService.submitUserInputResponse,
      compactTurn: async () => { throw new AppServerOperationError(503, "server_unavailable", "Local compaction is unavailable", undefined, false); },
    } : undefined,
    threadService,
    localLifecycleReplayService: {
      replayLifecycleEvents: (params: ReplayLifecycleEventsRequest) =>
        replayLocalLifecycle(persistence, threadService, params),
    },
  };
  const boundaryFailure = validateAppServerHttpBoundary(baseInput, composition);
  if (boundaryFailure) {
    writeJson(response, boundaryFailure.statusCode, boundaryFailure.payload, boundaryFailure.headers);
    return;
  }
  const imageOptIn = request.headers[LOCAL_APP_SERVER_IMAGE_REQUEST_HEADER];
  if (imageOptIn !== undefined && imageOptIn !== "1") {
    writeJson(response, 400, { code: "invalid_request", message: "Image upload request is invalid" });
    return;
  }
  // Authentication above is mandatory before accepting the larger image body.
  const body = await readBody(request, imageOptIn === "1"
    ? MAX_LOCAL_APP_SERVER_IMAGE_REQUEST_BYTES
    : MAX_LOCAL_APP_SERVER_REQUEST_BYTES);
  if (body.tooLarge) {
    writeJson(response, 413, { code: "invalid_request", message: "App Server request is too large" });
    return;
  }
  if (body.timedOut) {
    writeJson(response, 408, { code: "invalid_request", message: "App Server request timed out" });
    return;
  }
  if (imageOptIn === "1") {
    try {
      const envelope = AppServerRequestSchema.parse(JSON.parse(body.value));
      if (!isLocalAppServerImageRequest(envelope)) throw new Error("ineligible");
      assertLocalAppServerRequestBudget(envelope, body.value);
    } catch {
      writeJson(response, 400, { code: "invalid_request", message: "This request cannot upload images" });
      return;
    }
  }
  const rawProviderConfiguration = request.headers["x-legioncode-provider-configuration"];
  let providerConfiguration: ReturnType<typeof ProviderConfigurationSchema.parse> | undefined;
  if (rawProviderConfiguration !== undefined) {
    if (typeof rawProviderConfiguration !== "string" || rawProviderConfiguration.length > 1_024) {
      writeJson(response, 400, { code: "invalid_request", message: "Provider configuration header is invalid" });
      return;
    }
    try {
      providerConfiguration = ProviderConfigurationSchema.parse(JSON.parse(rawProviderConfiguration) as unknown);
    } catch {
      writeJson(response, 400, { code: "invalid_request", message: "Provider configuration header is invalid" });
      return;
    }
  }
  const result = await handleAppServerHttpRequest(
    {
      ...baseInput,
      rawBody: body.value,
    },
    { ...composition, providerService, providerConfiguration },
  );
  writeJson(response, result.statusCode, result.payload, result.headers);
}

/** Read canonical runtime bytes only after resolving their thread in the current grant. */
async function replayLocalLifecycle(
  persistence: LocalPersistence,
  threadService: LocalThreadService,
  params: ReplayLifecycleEventsRequest,
) {
  if (params.backend && params.backend !== "execution-engine-v1") {
    throw new AppServerOperationError(400, "invalid_request", "Hosted execution backends are unavailable locally");
  }
  const first = await persistence.lifecycleEvents.replay({
    turnId: params.turnId, afterSequence: null, limit: 1,
  });
  const event = first.events[0];
  if (!event) throw new AppServerOperationError(404, "not_found", "Local turn was not found");
  try {
    await threadService.get(event.threadId);
  } catch (error) {
    if (error instanceof LocalThreadNotFoundError) {
      throw new AppServerOperationError(404, "not_found", "Local turn was not found in the granted workspace");
    }
    throw error;
  }
  return persistence.lifecycleEvents.replay({
    turnId: params.turnId,
    afterSequence: params.afterSequence ?? null,
    limit: params.limit ?? 1_000,
  });
}

function readBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<{ value: string; tooLarge: boolean; timedOut: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    const timer = setTimeout(() => {
      if (rejected) return;
      rejected = true;
      chunks.length = 0;
      request.resume();
      resolve({ value: "", tooLarge: false, timedOut: true });
    }, 15_000);
    request.on("data", (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > maxBytes) {
        rejected = true;
        chunks.length = 0;
        clearTimeout(timer);
        request.resume();
        resolve({ value: "", tooLarge: true, timedOut: false });
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => {
      if (rejected) return;
      clearTimeout(timer);
      resolve({ value: Buffer.concat(chunks).toString("utf8"), tooLarge: false, timedOut: false });
    });
    request.once("error", () => {
      if (!rejected) {
        clearTimeout(timer);
        resolve({ value: "", tooLarge: false, timedOut: false });
      }
    });
  });
}

function writeJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(payload));
}
