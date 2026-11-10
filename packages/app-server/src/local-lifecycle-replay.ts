import { createHash } from "node:crypto";
import type { LocalPersistence } from "@repo/event-store/local";
import { LifecycleReplayEventTooLargeError } from "@repo/event-store/errors";
import {
  APP_SERVER_DEFAULT_MAX_RESPONSE_BYTES, APP_SERVER_PROTOCOL_VERSION,
  appServerJsonByteLength, LIFECYCLE_EVENT_BYTE_READ_REQUIRED,
  LIFECYCLE_EVENT_CHUNK_MAX_BYTES, LifecycleEventBytesReferenceSchema,
  ReadLifecycleEventChunkResponseSchema,
  type LifecycleEvent, type LifecycleEventBytesReference,
  type ReadLifecycleEventChunkRequest, type ReplayLifecycleEventsRequest,
} from "@repo/platform-protocol";
import { LocalThreadNotFoundError, type LocalThreadService } from "./local-threads.js";
import { AppServerOperationError } from "./server.js";

const replayFrameBytes = appServerJsonByteLength({
  protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: "turn/lifecycleEvents", ok: true, result: null,
}) - appServerJsonByteLength(null);

/** Reads the existing immutable stream; byte references never become events. */
export class LocalLifecycleReplay {
  constructor(private readonly persistence: LocalPersistence, private readonly threads: LocalThreadService) {}

  async replayLifecycleEvents(params: ReplayLifecycleEventsRequest) {
    const scope = await this.authorize(params);
    try {
      const page = await this.persistence.lifecycleEvents.replay({
        turnId: params.turnId, afterSequence: params.afterSequence ?? null,
        limit: params.limit ?? 1_000, maxBytes: APP_SERVER_DEFAULT_MAX_RESPONSE_BYTES - replayFrameBytes,
      });
      page.events.forEach(scope.validate);
      await scope.reauthorize();
      return page;
    } catch (error) {
      if (!(error instanceof LifecycleReplayEventTooLargeError)) throw error;
      const event = await this.readOne(params.turnId, (params.afterSequence ?? 0) + 1, scope.validate);
      if (event.turnId !== error.turnId || event.eventId !== error.eventId || event.sequence !== error.sequence) throw corrupt();
      const { reference } = encode(event);
      if (reference.byteLength !== error.encodedByteLength) throw corrupt();
      await scope.reauthorize();
      throw new AppServerOperationError(413, "invalid_request", "The next lifecycle event requires byte reads",
        LIFECYCLE_EVENT_BYTE_READ_REQUIRED, false, undefined, { reference });
    }
  }

  async readLifecycleEventChunk(params: ReadLifecycleEventChunkRequest) {
    const scope = await this.authorize(params);
    if (params.sequence < 1) {
      throw new AppServerOperationError(400, "invalid_request", "Lifecycle event sequence must be positive");
    }
    const event = await this.readOne(params.turnId, params.sequence, scope.validate);
    const { reference, bytes } = encode(event);
    if (reference.eventId !== params.eventId || reference.sha256 !== params.sha256) {
      throw new AppServerOperationError(409, "conflict", "Lifecycle byte reference does not match its canonical event");
    }
    if (params.offset >= bytes.byteLength) {
      throw new AppServerOperationError(400, "invalid_request", "Lifecycle chunk offset is outside the event");
    }
    const chunk = bytes.subarray(params.offset, params.offset + (params.limit ?? LIFECYCLE_EVENT_CHUNK_MAX_BYTES));
    const end = params.offset + chunk.byteLength;
    const response = ReadLifecycleEventChunkResponseSchema.parse({
      reference, offset: params.offset, byteLength: chunk.byteLength,
      dataBase64: chunk.toString("base64"), nextOffset: end < bytes.byteLength ? end : null,
    });
    await scope.reauthorize();
    return response;
  }

  private async readOne(turnId: ReplayLifecycleEventsRequest["turnId"], sequence: number, validate: (event: LifecycleEvent) => void) {
    const page = await this.persistence.lifecycleEvents.replay({ turnId, afterSequence: sequence - 1 || null, limit: 1 });
    const event = page.events[0];
    if (!event || event.sequence !== sequence) throw corrupt();
    validate(event);
    return event;
  }

  private async authorize(params: Pick<ReplayLifecycleEventsRequest, "turnId" | "backend">) {
    if (params.backend && params.backend !== "execution-engine-v1") {
      throw new AppServerOperationError(400, "invalid_request", "Hosted execution backends are unavailable locally");
    }
    const admission = await this.persistence.turnAdmissions.getByTurn(params.turnId);
    if (!admission) throw new AppServerOperationError(404, "not_found", "Local turn was not found");
    const reauthorize = async () => {
      try {
        const thread = await this.threads.get(admission.run.threadId);
        if (thread.workspaceId !== admission.run.workspaceId) throw new LocalThreadNotFoundError();
      } catch (error) {
        if (error instanceof LocalThreadNotFoundError) {
          throw new AppServerOperationError(404, "not_found", "Local turn was not found in the granted workspace");
        }
        throw error;
      }
    };
    await reauthorize();
    return {
      reauthorize,
      validate: (event: LifecycleEvent) => {
        if (event.threadId !== admission.run.threadId || event.turnId !== admission.turn.id ||
            event.runAttemptId !== admission.runAttemptId || event.producer.id !== admission.run.workerId) throw corrupt();
      },
    };
  }
}

function encode(event: LifecycleEvent): { reference: LifecycleEventBytesReference; bytes: Buffer } {
  const bytes = Buffer.from(JSON.stringify(event), "utf8");
  const reference = LifecycleEventBytesReferenceSchema.parse({ formatVersion: 1, turnId: event.turnId,
    eventId: event.eventId, sequence: event.sequence, byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex") });
  return { reference, bytes };
}

function corrupt() {
  return new AppServerOperationError(503, "server_unavailable", "Local turn history does not match its admission");
}
