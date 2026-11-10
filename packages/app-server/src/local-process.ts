import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { LocalPersistence } from "@repo/event-store/local";
import {
  AppServerRequestSchema,
  LOCAL_APP_SERVER_IMAGE_REQUEST_HEADER,
  MAX_LOCAL_APP_SERVER_IMAGE_REQUEST_BYTES,
  MAX_LOCAL_APP_SERVER_REQUEST_BYTES,
  assertLocalAppServerRequestBudget,
  isLocalAppServerImageRequest,
} from "./protocol.js";
import type { AppServerComposition } from "./server.js";
import { handleAppServerHttpRequest, validateAppServerHttpBoundary } from "./server.js";
import { LocalWorkspaceService, type LocalWorkspaceServiceOptions } from "./local-workspace.js";
import { DefaultGitService } from "@repo/git-service";
import { createNodeGitExecutor } from "./local-node-git-executor.js";
import type { VerifiedMacGitExecution, VerifiedMacGitOptions } from "./local-mac-git-execution.js";
import { LocalThreadService } from "./local-threads.js";
import { LocalProviderService, ProviderConfigurationSchema } from "./local-providers.js";
import type { LocalProviderModelCatalog } from "./local-provider-model-catalog.js";
import { LocalTurnService, type LocalTurnRuntime } from "./local-turns.js";
import { reconcileLostLocalTurns } from "./local-turn-recovery.js";
import { attachLocalServerShutdown, combineLocalShutdownOwners, createLocalHttpRequestDrain, type LocalShutdownOwner } from "./local-server-shutdown.js";
import { LocalProviderPreferences } from "./local-provider-preferences.js";
import { LocalTurnArtifactReads } from "./local-turn-artifact-reads.js";
import { LocalChatMediaStore } from "./local-chat-media-store.js";
import { LocalChatMediaReads } from "./local-chat-media-reads.js";
import { LocalLifecycleReplay } from "./local-lifecycle-replay.js";
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
  | { type: "closed" }
  | { type: "fatal"; reason?: "runtime-shutdown-failed" };

/** Private utility-process control, never an HTTP or renderer capability. */
export type LocalAppServerProcessControl = {
  requestShutdown(): Promise<void>;
};

export type LocalAppServerParentPort = {
  postMessage(message: LocalAppServerMessage): void;
};

export type LocalAppServerCompositionOptions = {
  providerModelCatalog?: LocalProviderModelCatalog;
  createMetadataInspector?: LocalWorkspaceServiceOptions["createMetadataInspector"];
  createProbeExecution?: (authority: Pick<VerifiedMacGitOptions, "probeRoot" | "withRootAuthority">) => Promise<VerifiedMacGitExecution>;
  createWorkspaceFilesService?(workspaces: LocalWorkspaceService): NonNullable<AppServerComposition["localWorkspaceFilesService"]>;
  createWorkspaceGitReadsService?(workspaces: LocalWorkspaceService): NonNullable<AppServerComposition["localWorkspaceGitReadsService"]> & LocalShutdownOwner;
  createTurnRuntime?(persistence: Pick<LocalPersistence, "turnAdmissions" | "lifecycleEvents" | "turnArtifacts">, media?: LocalTurnMediaPort): LocalTurnRuntime;
  createArtifactCommitService?(input: {
    persistence: Pick<LocalPersistence, "turnAdmissions" | "lifecycleEvents" | "turnArtifacts" | "workspaceGrants">;
    workspaces: LocalWorkspaceService;
    reads: LocalTurnArtifactReads;
  }): NonNullable<AppServerComposition["localTurnArtifactCommitService"]> & LocalShutdownOwner;
};

export async function createLocalAppServer(config: LocalAppServerStartConfig, options?: LocalAppServerCompositionOptions) {
  if (options?.createWorkspaceFilesService && !config.protectedHostRoots?.length) {
    throw new Error("Workspace file queries require trusted protected host roots");
  }
  if (options?.createWorkspaceGitReadsService && !config.protectedHostRoots?.length) {
    throw new Error("Workspace Git queries require trusted protected host roots");
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
    const providerPreferences = new LocalProviderPreferences({
      getWorkspace: () => workspaceService.getAuthorizedCurrent(),
      store: persistence.providerPreferences,
      providers: providerService,
    });
    const workspaceFilesService = options?.createWorkspaceFilesService?.(workspaceService);
    const workspaceGitReads = options?.createWorkspaceGitReadsService?.(workspaceService);
    const media = new LocalChatMediaStore({
      storageDirectory: config.storageDirectory,
      lookupAdmission: (scope) => persistence.turnAdmissions.getByTurn(scope.turnId),
    });
    const runtime = options?.createTurnRuntime?.(persistence, media);
    if (runtime) await reconcileLostLocalTurns(persistence, runtime);
    const turnService = runtime ? new LocalTurnService({
      persistence,
      workspaces: workspaceService,
      threads: threadService,
      providers: providerService,
      runtime,
      media,
    }) : undefined;
    const artifactReads = turnService ? new LocalTurnArtifactReads({
      turns: turnService,
      persistence,
    }) : undefined;
    const imageReads = turnService ? new LocalChatMediaReads({ turns: turnService, store: media }) : undefined;
    const artifactCommits = artifactReads ? options?.createArtifactCommitService?.({
      persistence, workspaces: workspaceService, reads: artifactReads,
    }) : undefined;
    const requests = createLocalHttpRequestDrain();
    const server = createServer((request, response) => {
      void requests.track(() => handleRequest(request, response, config, workspaceService, threadService, providerService, persistence, workspaceFilesService, workspaceGitReads, turnService, providerPreferences, artifactReads, imageReads, artifactCommits, () => requests.stopping));
    });
    return attachLocalServerShutdown(
      server, persistence, combineLocalShutdownOwners(turnService, artifactCommits, workspaceGitReads, requests),
      () => workspaceService.hasUnsettledResources,
    );
  } catch (error) {
    persistence.close();
    throw error;
  }
}

export async function runLocalAppServerProcess(
  parentPort: LocalAppServerParentPort,
  config: LocalAppServerStartConfig,
  options?: LocalAppServerCompositionOptions,
): Promise<LocalAppServerProcessControl | undefined> {
  let server: Awaited<ReturnType<typeof createLocalAppServer>>;
  try {
    server = await createLocalAppServer(config, options);
  } catch {
    postFatal();
    process.exit(1);
    return;
  }
  server.once("runtime-shutdown-failed", () => postFatal("runtime-shutdown-failed"));
  let finalExitCode = 0;
  let stopRequested = false;
  let exitAfterClosed: Promise<void> | undefined;
  const exitAfterSettlement = (exitCode: number): Promise<void> => {
    stopRequested = true;
    if (exitCode !== 0) finalExitCode = 1;
    const closed = server.requestShutdown();
    exitAfterClosed ??= closed.then(() => {
      // Physical closure receipt is separate from observing child process exit.
      try { parentPort.postMessage({ type: "closed" }); }
      finally { process.exit(finalExitCode); }
    }, () => undefined);
    return closed;
  };
  server.once("error", () => {
    postFatal();
    exitAfterSettlement(1);
  });
  process.on("SIGTERM", () => exitAfterSettlement(0));
  server.listen(0, "127.0.0.1", () => {
    if (stopRequested) return;
    const address = server.address();
    if (!address || typeof address === "string") {
      postFatal();
      exitAfterSettlement(1);
      return;
    }
    try {
      parentPort.postMessage({
        type: "ready",
        baseUrl: `http://127.0.0.1:${address.port}`,
      });
    } catch { void exitAfterSettlement(1); }
  });
  return { requestShutdown: () => exitAfterSettlement(0) };

  function postFatal(reason?: "runtime-shutdown-failed"): void {
    try { parentPort.postMessage({ type: "fatal", ...(reason ? { reason } : {}) }); }
    catch { /* Losing the notification channel is not physical closure. */ }
  }
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
  workspaceGitReads?: AppServerComposition["localWorkspaceGitReadsService"],
  turnService?: LocalTurnService,
  providerPreferences?: LocalProviderPreferences,
  artifactReads?: LocalTurnArtifactReads,
  imageReads?: LocalChatMediaReads,
  artifactCommits?: AppServerComposition["localTurnArtifactCommitService"],
  isShuttingDown: () => boolean = () => false,
): Promise<void> {
  const baseInput = {
    method: request.method ?? "",
    path: request.url ?? "/",
    host: request.headers.host,
    origin: request.headers.origin,
    authorization: request.headers.authorization,
    contentType: request.headers["content-type"],
  };
  const composition = {
    environment: "local" as const,
    serverId: "legioncode-local",
    serverVersion: config.serverVersion,
    credential: config.credential,
    workspaceService,
    localWorkspaceFilesService: workspaceFilesService,
    localWorkspaceGitReadsService: workspaceGitReads,
    localTurnService: turnService,
    localProviderPreferenceService: providerPreferences,
    localTurnArtifactReadsService: artifactReads,
    localChatMediaService: imageReads,
    localTurnArtifactCommitService: artifactCommits,
    threadService,
    localLifecycleReplayService: new LocalLifecycleReplay(persistence, threadService),
  };
  const boundaryFailure = validateAppServerHttpBoundary(baseInput, composition);
  if (boundaryFailure) {
    writeJson(response, boundaryFailure.statusCode, boundaryFailure.payload, boundaryFailure.headers);
    return;
  }
  if (isShuttingDown()) {
    writeJson(response, 503, { code: "server_unavailable", message: "Local App Server is shutting down", operationCode: "server_shutting_down", retryable: false });
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
  // A body may finish after shutdown fenced new work. Do not dispatch it then.
  if (isShuttingDown()) {
    writeJson(response, 503, { code: "server_unavailable", message: "Local App Server is shutting down", operationCode: "server_shutting_down", retryable: false });
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
