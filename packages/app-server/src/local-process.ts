import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { LocalPersistence } from "@repo/event-store/local";
import type { ReplayLifecycleEventsRequest } from "@repo/platform-protocol";
import {
  AppServerRequestSchema,
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
import { LocalTurnService, type LocalTurnRuntime } from "./local-turns.js";
import { reconcileLostLocalTurns } from "./local-turn-recovery.js";
import { attachLocalServerShutdown } from "./local-server-shutdown.js";
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
  createMetadataInspector?: LocalWorkspaceServiceOptions["createMetadataInspector"];
  createProbeExecution?: (authority: Pick<VerifiedMacGitOptions, "probeRoot" | "withRootAuthority">) => Promise<VerifiedMacGitExecution>;
  createWorkspaceFilesService?(workspaces: LocalWorkspaceService): NonNullable<AppServerComposition["localWorkspaceFilesService"]>;
  createTurnRuntime?(persistence: Pick<LocalPersistence, "turnAdmissions" | "lifecycleEvents" | "turnArtifacts">, media?: LocalTurnMediaPort): LocalTurnRuntime;
  createArtifactCommitService?(input: {
    persistence: Pick<LocalPersistence, "turnAdmissions" | "lifecycleEvents" | "turnArtifacts" | "workspaceGrants">;
    workspaces: LocalWorkspaceService;
    reads: LocalTurnArtifactReads;
  }): NonNullable<AppServerComposition["localTurnArtifactCommitService"]>;
};

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
    });
    const providerService = new LocalProviderService({
      selectionStore: persistence.providerSelection,
    });
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
    const server = createServer((request, response) => {
      void handleRequest(request, response, config, workspaceService, threadService, providerService, persistence, workspaceFilesService, turnService, providerPreferences, artifactReads, imageReads, artifactCommits);
    });
    return attachLocalServerShutdown(server, persistence, turnService);
  } catch (error) {
    persistence.close();
    throw error;
  }
}

export async function runLocalAppServerProcess(
  parentPort: LocalAppServerParentPort,
  config: LocalAppServerStartConfig,
  options?: LocalAppServerCompositionOptions,
): Promise<void> {
  let server: Awaited<ReturnType<typeof createLocalAppServer>>;
  try {
    server = await createLocalAppServer(config, options);
  } catch {
    parentPort.postMessage({ type: "fatal" });
    process.exit(1);
    return;
  }
  server.once("runtime-shutdown-failed", () => parentPort.postMessage({ type: "fatal" }));
  const exitAfterClose = () => {
    void server.closed.then(() => process.exit(1), () => undefined);
  };
  server.once("error", () => {
    parentPort.postMessage({ type: "fatal" });
    server.close(exitAfterClose);
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      parentPort.postMessage({ type: "fatal" });
      server.close(exitAfterClose);
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
  turnService?: LocalTurnService,
  providerPreferences?: LocalProviderPreferences,
  artifactReads?: LocalTurnArtifactReads,
  imageReads?: LocalChatMediaReads,
  artifactCommits?: AppServerComposition["localTurnArtifactCommitService"],
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
    localTurnService: turnService,
    localProviderPreferenceService: providerPreferences,
    localTurnArtifactReadsService: artifactReads,
    localChatMediaService: imageReads,
    localTurnArtifactCommitService: artifactCommits,
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
  const authorizeThread = async () => {
    try {
      await threadService.get(event.threadId);
    } catch (error) {
      if (error instanceof LocalThreadNotFoundError) {
        throw new AppServerOperationError(404, "not_found", "Local turn was not found in the granted workspace");
      }
      throw error;
    }
  };
  await authorizeThread();
  const page = await persistence.lifecycleEvents.replay({
    turnId: params.turnId,
    afterSequence: params.afterSequence ?? null,
    limit: params.limit ?? 1_000,
  });
  await authorizeThread();
  return page;
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
