import type { RuntimeEventInboxAcceptResult } from "@repo/persistence";
import {
  isDomainError,
  mapDomainErrorToHttp,
} from "../domain/errors";
import { errorResponse, jsonResponse } from "../http/response";
import { withPostgresRuntimeEventIngestionService } from "../services/runtime-events/PostgresRuntimeEventIngestionFactory";
import type { RuntimeEventIngestionService } from "../services/runtime-events/RuntimeEventIngestionService";
import type { Env } from "../types/ai";

export interface RuntimeEventControllerDependencies {
  withService<T>(
    env: Env,
    callback: (service: RuntimeEventIngestionService) => Promise<T>,
  ): Promise<T>;
}

const DEFAULT_DEPENDENCIES: RuntimeEventControllerDependencies = {
  withService: withPostgresRuntimeEventIngestionService,
};

export class RuntimeEventController {
  static async acceptInternalRuntimeEvent(
    request: Request,
    env: Env,
    dependencies: RuntimeEventControllerDependencies = DEFAULT_DEPENDENCIES,
  ): Promise<Response> {
    try {
      const rawBody = await request.text();
      const result = await dependencies.withService(env, (service) =>
        service.accept({
          rawBody,
          headers: request.headers,
        }),
      );

      return jsonResponse(request, env, toResponseBody(result), {
        status: result.inserted ? 202 : 200,
      });
    } catch (error) {
      return toRuntimeEventErrorResponse(request, env, error);
    }
  }
}

function toResponseBody(result: RuntimeEventInboxAcceptResult): {
  accepted: true;
  inserted: boolean;
  eventId: string;
  status: string;
} {
  return {
    accepted: true,
    inserted: result.inserted,
    eventId: result.entry.id,
    status: result.entry.status,
  };
}

function toRuntimeEventErrorResponse(
  request: Request,
  env: Env,
  error: unknown,
): Response {
  if (isDomainError(error)) {
    const mapped = mapDomainErrorToHttp(error);
    return errorResponse(
      request,
      env,
      mapped.message,
      mapped.status,
      mapped.code,
      mapped.metadata,
    );
  }

  console.error("[persistence/run] Runtime event ingestion failed:", error);
  return errorResponse(
    request,
    env,
    "Runtime event ingestion failed",
    500,
    "RUNTIME_EVENT_INGESTION_FAILED",
  );
}
