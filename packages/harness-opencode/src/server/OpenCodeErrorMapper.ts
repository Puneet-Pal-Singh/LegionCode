import type { OpenCodeEvent } from "@opencode/client";
import {
  toPublicProtocolError,
  type ProtocolError,
  type ProtocolErrorCode,
} from "@repo/platform-protocol";

type NativeFailure = Extract<
  OpenCodeEvent,
  { type: "session.execution.failed" }
>["data"]["error"];

/** Pinned structured error discriminants only. Never forward provider prose or response bodies. */
export function openCodeFailure(
  error: NativeFailure,
  fallback: "provider_unavailable" | "command_failed" = "provider_unavailable",
): ProtocolError {
  let code: ProtocolErrorCode;
  switch (error.type) {
    case "permission.rejected":
      code = "policy_denied";
      break;
    case "provider.auth":
      code = "unauthorized";
      break;
    case "provider.no-route":
      code = "model_unavailable";
      break;
    case "provider.unsupported-operation":
      code = "capability_unsupported";
      break;
    case "provider.rate-limit":
    case "provider.quota":
    case "provider.free-limit":
    case "provider.budget-limit":
    case "provider.model-budget-limit":
    case "provider.go-limit":
    case "provider.chatgpt-limit":
      code = "rate_limited";
      break;
    default:
      code =
        error.status === 401
          ? "unauthorized"
          : error.status === 403
            ? "forbidden"
            : error.status === 429
              ? "rate_limited"
              : fallback;
  }
  return toPublicProtocolError({
    code,
    // A public classification is never authorization to retry an external effect.
    retryable: false,
    details:
      error.status === undefined ? null : { providerStatusCode: error.status },
  });
}
