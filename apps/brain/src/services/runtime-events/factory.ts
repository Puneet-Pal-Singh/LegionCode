import type { RuntimeEventInboxRepository } from "@repo/persistence";
import { DependencyError } from "../../domain/errors";
import type { Env } from "../../types/ai";
import { RuntimeEventIngestionService } from "./RuntimeEventIngestionService";
import { RuntimeEventSignatureVerifier } from "./RuntimeEventSignatureVerifier";

export function createRuntimeEventIngestionService(
  env: Env,
  repository: RuntimeEventInboxRepository,
): RuntimeEventIngestionService {
  const secret = env.INTERNAL_RUNTIME_EVENT_SECRET?.trim();
  if (!secret) {
    throw new DependencyError(
      "INTERNAL_RUNTIME_EVENT_SECRET is required for runtime event ingestion",
      "RUNTIME_EVENT_SECRET_MISSING",
      false,
    );
  }

  return new RuntimeEventIngestionService(
    repository,
    new RuntimeEventSignatureVerifier(secret),
    env,
  );
}
