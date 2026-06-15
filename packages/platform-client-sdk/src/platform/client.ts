import { z } from "zod";
import {
  ArtifactIdSchema,
  ArtifactMetadataSchema,
  EventCursorSchema,
  RunEventSchema,
  RunIdSchema,
  RunSchema,
  ThreadSchema,
  ThreadIdSchema,
  WorkspaceManifestSchema,
  type ArtifactId,
  type RunEvent,
} from "@repo/platform-protocol";
import {
  PlatformClientContractError,
  normalizePlatformClientOperationError,
} from "./errors.js";
import {
  AttachRunStreamRequestSchema,
  CreateRunRequestSchema,
  CreateThreadRequestSchema,
  ListArtifactsRequestSchema,
  ListArtifactsResponseSchema,
  ListThreadsRequestSchema,
  ListThreadsResponseSchema,
  ReplayRunEventsRequestSchema,
  ReplayRunEventsResponseSchema,
  StreamRetryPolicySchema,
  SubmitApprovalRequestSchema,
  type AttachRunStreamRequest,
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

  async getThread(
    threadId: string,
    options?: PlatformClientOperationOptions,
  ) {
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

  async *attachRunStream(
    request: AttachRunStreamRequest,
    options?: PlatformClientOperationOptions,
  ): AsyncIterable<RunEvent> {
    const normalizedRequest = parseRequest(
      request,
      AttachRunStreamRequestSchema,
      "attachRunStream",
    );
    let afterCursor = normalizedRequest.afterCursor ?? null;
    const retry = options?.streamRetry
      ? parseRequest(
          options.streamRetry,
          StreamRetryPolicySchema,
          "attachRunStream",
        )
      : undefined;
    const maxAttempts = retry?.maxAttempts ?? 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const stream = this.transport.attachRunStream(
          { ...normalizedRequest, afterCursor },
          options,
        );
        for await (const event of stream) {
          const parsed = parseResponse(
            event,
            RunEventSchema,
            "attachRunStream",
          );
          afterCursor = EventCursorSchema.parse(parsed.cursor);
          yield parsed;
        }
        return;
      } catch (error) {
        const normalized = normalizePlatformClientOperationError(
          error,
          "attachRunStream",
        );
        if (!normalized.retryable || attempt === maxAttempts) {
          throw normalized;
        }
        await waitForRetry(retry?.delayMs ?? 0, options?.signal);
      }
    }
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
    return parseResponse(
      payload,
      ListArtifactsResponseSchema,
      "listArtifacts",
    );
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

async function waitForRetry(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw new DOMException("Request was aborted", "AbortError");
  }
  if (delayMs === 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, delayMs);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new DOMException("Request was aborted", "AbortError"));
      },
      { once: true },
    );
  });
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
