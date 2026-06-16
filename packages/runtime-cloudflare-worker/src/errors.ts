import type { JsonRecord } from "@repo/platform-protocol";
import type {
  WorkerProtocolError,
  WorkerProtocolErrorCode,
} from "@repo/worker-protocol";

export class CloudflareWorkerAdapterError extends Error {
  constructor(readonly protocolError: WorkerProtocolError) {
    super(protocolError.message);
    this.name = "CloudflareWorkerAdapterError";
  }
}

export function createCloudflareWorkerAdapterError(
  code: WorkerProtocolErrorCode,
  message: string,
  retryable = false,
  details: JsonRecord | null = null,
): CloudflareWorkerAdapterError {
  return new CloudflareWorkerAdapterError({
    code,
    message,
    retryable,
    correlationId: null,
    details,
  });
}

export function normalizeCloudflareWorkerError(
  error: unknown,
  code: WorkerProtocolErrorCode,
): CloudflareWorkerAdapterError {
  if (error instanceof CloudflareWorkerAdapterError) {
    return error;
  }
  return createCloudflareWorkerAdapterError(
    code,
    error instanceof Error ? error.message : "Cloudflare worker operation failed",
  );
}
