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

export interface RuntimeEventIngestionInput {
  rawBody: string;
  headers: Headers;
}

export class RuntimeEventIngestionService {
  constructor(
    private readonly repository: RuntimeEventInboxRepository,
    private readonly verifier: RuntimeEventSignatureVerifier,
  ) {}

  async accept(
    input: RuntimeEventIngestionInput,
  ): Promise<RuntimeEventInboxAcceptResult> {
    await this.verifier.verify({
      rawBody: input.rawBody,
      headers: input.headers,
    });

    const event = parseRuntimeEvent(input.rawBody);
    return this.repository.accept(event);
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
