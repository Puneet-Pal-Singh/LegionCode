import { z } from "zod";
import {
  ArtifactIdSchema,
  ArtifactMetadataSchema,
  LifecycleEventSchema,
  RunEventSchema,
  RunIdSchema,
  RunSchema,
  ThreadSchema,
  ThreadIdSchema,
  WorkspaceManifestSchema,
  type ArtifactId,
} from "@repo/platform-protocol";
import {
  PlatformClientContractError,
  normalizePlatformClientOperationError,
} from "./errors.js";
import { followLifecycleEvents } from "./lifecycle-continuation.js";
import {
  FollowLifecycleRequestSchema,
  GetTurnDiffRequestSchema,
  GetTurnDiffResponseSchema,
  InterruptTurnRequestSchema,
  InterruptTurnResponseSchema,
  CompactTurnRequestSchema,
  CompactTurnResponseSchema,
  ReplayLifecycleEventsRequestSchema,
  ReplayLifecycleEventsResponseSchema,
  StartTurnRequestSchema,
  StartTurnResponseSchema,
  SubmitLifecycleApprovalRequestSchema,
  SubmitUserInputResponseRequestSchema,
  type FollowLifecycleRequest,
  type GetTurnDiffRequest,
  type InterruptTurnRequest,
  type ReplayLifecycleEventsRequest,
  type ReplayLifecycleEventsResponse,
  type StartTurnRequest,
  type SubmitLifecycleApprovalRequest,
  type SubmitUserInputResponseRequest,
  type CompactTurnRequest,
} from "./lifecycle-types.js";
import {
  CreateRunRequestSchema,
  CreateThreadRequestSchema,
  ListArtifactsRequestSchema,
  ListArtifactsResponseSchema,
  ListThreadsRequestSchema,
  ListThreadsResponseSchema,
  ReplayRunEventsRequestSchema,
  ReplayRunEventsResponseSchema,
  SubmitApprovalRequestSchema,
  type CreateRunRequest,
  type CreateThreadRequest,
  type ListArtifactsRequest,
  type ListThreadsRequest,
  type PlatformClient,
  type PlatformClientOperationOptions,
  type PlatformClientTransport,
  type ReplayRunEventsRequest,
  type ReplayRunEventsResponse,
  type SubmitApprovalRequest,
} from "./types.js";

export class DefaultPlatformClient implements PlatformClient {
  constructor(private readonly transport: PlatformClientTransport) {}

  async createThread(
    request: CreateThreadRequest,
    options?: PlatformClientOperationOptions,
  ) {
    const normalizedRequest = parseRequest(
      request,
      CreateThreadRequestSchema,
      "createThread",
    );
    const payload = await this.invoke("createThread", () =>
      this.transport.createThread(normalizedRequest, options),
    );
    return parseResponse(payload, ThreadSchema, "createThread");
  }

  async createRun(
    request: CreateRunRequest,
    options?: PlatformClientOperationOptions,
  ) {
    const normalizedRequest = parseRequest(
      request,
      CreateRunRequestSchema,
      "createRun",
    );
    const payload = await this.invoke("createRun", () =>
      this.transport.createRun(normalizedRequest, options),
    );
    return parseResponse(payload, RunSchema, "createRun");
  }

  async startTurn(
    request: StartTurnRequest,
    options?: PlatformClientOperationOptions,
  ) {
    const normalizedRequest = parseRequest(
      request,
      StartTurnRequestSchema,
      "startTurn",
    );
    const payload = await this.invoke("startTurn", () =>
      this.transport.startTurn(normalizedRequest, options),
    );
    return parseResponse(payload, StartTurnResponseSchema, "startTurn");
  }

  async getThread(threadId: string, options?: PlatformClientOperationOptions) {
    const normalizedThreadId = parseRequest(
      threadId,
      ThreadIdSchema,
      "getThread",
    );
    const payload = await this.invoke("getThread", () =>
      this.transport.getThread(normalizedThreadId, options),
    );
    return parseResponse(payload, ThreadSchema, "getThread");
  }

  async listThreads(
    request: ListThreadsRequest,
    options?: PlatformClientOperationOptions,
  ) {
    const normalizedRequest = parseRequest(
      request,
      ListThreadsRequestSchema,
      "listThreads",
    );
    const payload = await this.invoke("listThreads", () =>
      this.transport.listThreads(normalizedRequest, options),
    );
    return parseResponse(payload, ListThreadsResponseSchema, "listThreads");
  }

  async getRun(runId: string, options?: PlatformClientOperationOptions) {
    const normalizedRunId = parseRequest(runId, RunIdSchema, "getRun");
    const payload = await this.invoke("getRun", () =>
      this.transport.getRun(normalizedRunId, options),
    );
    return parseResponse(payload, RunSchema, "getRun");
  }

  async *followTurnLifecycle(
    request: FollowLifecycleRequest,
    options?: PlatformClientOperationOptions,
  ) {
    const normalizedRequest = parseRequest(
      request,
      FollowLifecycleRequestSchema,
      "followTurnLifecycle",
    );
    yield* followLifecycleEvents({
      request: normalizedRequest,
      options,
      replay: (input, replayOptions) =>
        this.replayLifecycleEvents(input, replayOptions),
    });
  }

  async replayRunEvents(
    request: ReplayRunEventsRequest,
    options?: PlatformClientOperationOptions,
  ): Promise<ReplayRunEventsResponse> {
    const normalizedRequest = parseRequest(
      request,
      ReplayRunEventsRequestSchema,
      "replayRunEvents",
    );
    const payload = await this.invoke("replayRunEvents", () =>
      this.transport.replayRunEvents(normalizedRequest, options),
    );
    const envelope = parseResponse(
      payload,
      ReplayRunEventsResponseSchema,
      "replayRunEvents",
    );
    return {
      events: envelope.events.map((event) =>
        parseResponse(event, RunEventSchema, "replayRunEvents"),
      ),
      nextCursor: envelope.nextCursor,
    };
  }

  async replayLifecycleEvents(
    request: ReplayLifecycleEventsRequest,
    options?: PlatformClientOperationOptions,
  ): Promise<ReplayLifecycleEventsResponse> {
    const normalizedRequest = parseRequest(
      request,
      ReplayLifecycleEventsRequestSchema,
      "replayLifecycleEvents",
    );
    const payload = await this.invoke("replayLifecycleEvents", () =>
      this.transport.replayLifecycleEvents(normalizedRequest, options),
    );
    return parseResponse(
      payload,
      ReplayLifecycleEventsResponseSchema,
      "replayLifecycleEvents",
    );
  }

  async interruptTurn(
    request: InterruptTurnRequest,
    options?: PlatformClientOperationOptions,
  ) {
    const normalizedRequest = parseRequest(
      request,
      InterruptTurnRequestSchema,
      "interruptTurn",
    );
    const payload = await this.invoke("interruptTurn", () =>
      this.transport.interruptTurn(normalizedRequest, options),
    );
    return parseResponse(payload, InterruptTurnResponseSchema, "interruptTurn");
  }

  async compactTurn(
    request: CompactTurnRequest,
    options?: PlatformClientOperationOptions,
  ) {
    const normalizedRequest = parseRequest(
      request,
      CompactTurnRequestSchema,
      "compactTurn",
    );
    const payload = await this.invoke("compactTurn", () =>
      this.transport.compactTurn(normalizedRequest, options),
    );
    return parseResponse(payload, CompactTurnResponseSchema, "compactTurn");
  }

  async submitApproval(
    request: SubmitApprovalRequest,
    options?: PlatformClientOperationOptions,
  ) {
    const normalizedRequest = parseRequest(
      request,
      SubmitApprovalRequestSchema,
      "submitApproval",
    );
    const payload = await this.invoke("submitApproval", () =>
      this.transport.submitApproval(normalizedRequest, options),
    );
    return parseResponse(payload, RunEventSchema, "submitApproval");
  }

  async submitLifecycleApproval(
    request: SubmitLifecycleApprovalRequest,
    options?: PlatformClientOperationOptions,
  ) {
    const normalizedRequest = parseRequest(
      request,
      SubmitLifecycleApprovalRequestSchema,
      "submitLifecycleApproval",
    );
    const payload = await this.invoke("submitLifecycleApproval", () =>
      this.transport.submitLifecycleApproval(normalizedRequest, options),
    );
    return parseResponse(
      payload,
      LifecycleEventSchema,
      "submitLifecycleApproval",
    );
  }

  async submitUserInputResponse(
    request: SubmitUserInputResponseRequest,
    options?: PlatformClientOperationOptions,
  ) {
    const normalizedRequest = parseRequest(
      request,
      SubmitUserInputResponseRequestSchema,
      "submitUserInputResponse",
    );
    const payload = await this.invoke("submitUserInputResponse", () =>
      this.transport.submitUserInputResponse(normalizedRequest, options),
    );
    return parseResponse(
      payload,
      LifecycleEventSchema,
      "submitUserInputResponse",
    );
  }

  async getTurnDiff(
    request: GetTurnDiffRequest,
    options?: PlatformClientOperationOptions,
  ) {
    const normalizedRequest = parseRequest(
      request,
      GetTurnDiffRequestSchema,
      "getTurnDiff",
    );
    const payload = await this.invoke("getTurnDiff", () =>
      this.transport.getTurnDiff(normalizedRequest, options),
    );
    return parseResponse(payload, GetTurnDiffResponseSchema, "getTurnDiff")
      .diff;
  }

  async getArtifact(
    artifactId: ArtifactId,
    options?: PlatformClientOperationOptions,
  ) {
    const normalizedArtifactId = parseRequest(
      artifactId,
      ArtifactIdSchema,
      "getArtifact",
    );
    const payload = await this.invoke("getArtifact", () =>
      this.transport.getArtifact(normalizedArtifactId, options),
    );
    return parseResponse(payload, ArtifactMetadataSchema, "getArtifact");
  }

  async listArtifacts(
    request: ListArtifactsRequest,
    options?: PlatformClientOperationOptions,
  ) {
    const normalizedRequest = parseRequest(
      request,
      ListArtifactsRequestSchema,
      "listArtifacts",
    );
    const payload = await this.invoke("listArtifacts", () =>
      this.transport.listArtifacts(normalizedRequest, options),
    );
    return parseResponse(payload, ListArtifactsResponseSchema, "listArtifacts");
  }

  async getWorkspaceManifest(
    runId: string,
    options?: PlatformClientOperationOptions,
  ) {
    const normalizedRunId = parseRequest(
      runId,
      RunIdSchema,
      "getWorkspaceManifest",
    );
    const payload = await this.invoke("getWorkspaceManifest", () =>
      this.transport.getWorkspaceManifest(normalizedRunId, options),
    );
    return parseResponse(
      payload,
      WorkspaceManifestSchema,
      "getWorkspaceManifest",
    );
  }

  private async invoke<T>(
    operation: string,
    run: () => Promise<T> | T,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw normalizePlatformClientOperationError(error, operation);
    }
  }
}

export function createPlatformClient(
  transport: PlatformClientTransport,
): PlatformClient {
  return new DefaultPlatformClient(transport);
}

function parseRequest<TSchema extends z.ZodTypeAny>(
  payload: unknown,
  schema: TSchema,
  operation: string,
): z.output<TSchema> {
  return parseContract(payload, schema, "request", operation);
}

function parseResponse<TSchema extends z.ZodTypeAny>(
  payload: unknown,
  schema: TSchema,
  operation: string,
): z.output<TSchema> {
  return parseContract(payload, schema, "response", operation);
}

function parseContract<TSchema extends z.ZodTypeAny>(
  payload: unknown,
  schema: TSchema,
  phase: "request" | "response",
  operation: string,
): z.output<TSchema> {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new PlatformClientContractError(
      phase,
      operation,
      `Invalid ${phase} contract for ${operation}`,
    );
  }
  return parsed.data;
}
