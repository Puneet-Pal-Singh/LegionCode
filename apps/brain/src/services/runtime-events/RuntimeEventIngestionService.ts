import {
  InternalRuntimeEventRequestSchema,
  type InternalRuntimeEventRequest,
} from "@repo/shared-types";
import type {
  RuntimeEventInboxAcceptResult,
  RuntimeEventInboxRepository,
} from "@repo/persistence";
import { ParseError, ValidationError } from "../../domain/errors";
import type { RuntimeEventSignatureVerifier } from "./RuntimeEventSignatureVerifier";
import {
  RuntimeEventProcessor,
  type RuntimeEventProcessorPort,
} from "./RuntimeEventProcessor";
import type { Env } from "../../types/ai";

export interface RuntimeEventIngestionInput {
  rawBody: string;
  headers: Headers;
}

export class RuntimeEventIngestionService {
  private processor: RuntimeEventProcessorPort;

  constructor(
    private readonly repository: RuntimeEventInboxRepository,
    private readonly verifier: RuntimeEventSignatureVerifier,
    env: Env,
    processor?: RuntimeEventProcessorPort,
  ) {
    this.processor = processor ?? new RuntimeEventProcessor(env);
  }

  async accept(
    input: RuntimeEventIngestionInput,
  ): Promise<RuntimeEventInboxAcceptResult> {
    await this.verifier.verify({
      rawBody: input.rawBody,
      headers: input.headers,
    });

    const event = parseRuntimeEvent(input.rawBody);
    const result = await this.repository.accept(event);

    if (result.inserted || result.entry.status !== "processed") {
      try {
        await this.processor.process(event);
        const processedEntry = await this.repository.markProcessed(
          result.entry.id,
          new Date().toISOString(),
        );
        return { ...result, entry: processedEntry };
      } catch (error) {
        console.error("[RuntimeEventIngestionService] Processing failed:", error);
        await this.repository.markFailed(
          result.entry.id,
          error instanceof Error ? error.message : String(error),
        );
        throw new Error(
          `Failed to process runtime event: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return result;
  }
}

function parseRuntimeEvent(rawBody: string): InternalRuntimeEventRequest {
  const parsed = parseJson(rawBody);
  const result = InternalRuntimeEventRequestSchema.safeParse(parsed);

  if (!result.success) {
    const details = result.error.errors
      .map((error) => `${error.path.join(".") || "body"}: ${error.message}`)
      .join("; ");
    throw new ValidationError(
      `Invalid runtime event body: ${details}`,
      "INVALID_RUNTIME_EVENT_BODY",
    );
  }

  return result.data;
}

function parseJson(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    throw new ParseError(
      "Malformed runtime event JSON body",
      "MALFORMED_RUNTIME_EVENT_BODY",
    );
  }
}
