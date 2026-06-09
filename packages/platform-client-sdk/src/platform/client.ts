import { z } from "zod";
import {
  ArtifactIdSchema,
  ArtifactMetadataSchema,
  RunEventSchema,
  RunIdSchema,
  RunSchema,
  ThreadSchema,
  WorkspaceManifestSchema,
  type ArtifactId,
  type RunEvent,
} from "@repo/platform-protocol";
import {
  PlatformClientContractError,
  normalizePlatformClientOperationError,
} from "./errors.js";
import {
  AppendRunEventRequestSchema,
  AttachRunStreamRequestSchema,
  CreateRunRequestSchema,
  CreateThreadRequestSchema,
  ReplayRunEventsRequestSchema,
  ReplayRunEventsResponseSchema,
  SubmitApprovalRequestSchema,
  type AppendRunEventRequest,
  type AttachRunStreamRequest,
  type CreateRunRequest,
  type CreateThreadRequest,
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

  async appendRunEvent(
    request: AppendRunEventRequest,
    options?: PlatformClientOperationOptions,
  ) {
    const normalizedRequest = parseRequest(
      request,
      AppendRunEventRequestSchema,
      "appendRunEvent",
    ) as AppendRunEventRequest;
    const payload = await this.invoke("appendRunEvent", () =>
      this.transport.appendRunEvent(normalizedRequest, options),
    );
    return parseResponse(payload, RunEventSchema, "appendRunEvent");
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
    const stream = await this.invoke("attachRunStream", () =>
      this.transport.attachRunStream(normalizedRequest, options),
    );

    for await (const event of stream) {
      yield parseResponse(event, RunEventSchema, "attachRunStream");
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
