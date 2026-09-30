import type { CoreMessage } from "ai";
import { decodeThreadTitle } from "./ThreadTitleOutput";
import { buildThreadTitleInput } from "./ThreadTitleInput";
import type { ThreadTitleGenerator } from "./ThreadTitleGenerationCoordinator";

export type TitleAttemptResult =
  | { ok: true; title: string }
  | {
      ok: false;
      reason: string;
      retryable: boolean;
      correction?: CoreMessage[];
    };

export function classifyTitleProviderError(error: unknown): {
  reason: string;
  retryable: boolean;
} {
  if (typeof error === "object" && error !== null) {
    const status =
      "statusCode" in error
        ? error.statusCode
        : "status" in error
          ? error.status
          : undefined;
    if (status === 401 || status === 403)
      return { reason: "authentication_failed", retryable: false };
    if (status === 400 || status === 404 || status === 422)
      return { reason: "unsupported_request", retryable: false };
    if (status === 429) return { reason: "rate_limited", retryable: true };
    if ("isRetryable" in error && error.isRetryable === false)
      return { reason: "provider_unavailable", retryable: false };
  }
  if (
    error instanceof Error &&
    /schema|parse|validation|object generated/iu.test(error.message)
  ) {
    return { reason: "malformed_output", retryable: true };
  }
  return { reason: "provider_unavailable", retryable: true };
}

/** Race the request as well as aborting it: adapters must not extend the worker deadline. */
export async function attemptThreadTitle(
  generator: ThreadTitleGenerator,
  request: Parameters<ThreadTitleGenerator["generateText"]>[0],
  deadline: number,
): Promise<TitleAttemptResult> {
  const allowance = Math.min(6000, deadline - Date.now());
  if (allowance <= 0) return { ok: false, reason: "timeout", retryable: false };
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const startedAt = Date.now();
  let outcome = "provider_unavailable";
  let finishReason: string | undefined;
  let tokens: number | undefined;
  try {
    const result = await Promise.race([
      generator.generateText({
        ...request,
        signal: controller.signal,
        temperature: 0,
        maxOutputTokens: 128,
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("title_attempt_timeout"));
        }, allowance);
      }),
    ]);
    finishReason = result.finishReason;
    tokens = result.usage?.totalTokens;
    const decoded =
      result.finishReason === "length"
        ? { ok: false as const, reason: "title_too_long" as const }
        : decodeThreadTitle(result.text);
    if (decoded.ok) {
      outcome = "ready";
      return decoded;
    }
    outcome = decoded.reason;
    return {
      ok: false,
      reason: decoded.reason,
      retryable: true,
      correction: [
        {
          role: "assistant",
          content: buildThreadTitleInput(result.text).slice(0, 512),
        },
        {
          role: "user",
          content: `The previous title was rejected (${decoded.reason}). Return one natural title of at most 50 characters in the required output format. Do not explain or answer the conversation.`,
        },
      ],
    };
  } catch (error) {
    const failure = controller.signal.aborted
      ? { reason: "timeout", retryable: true }
      : classifyTitleProviderError(error);
    outcome = failure.reason;
    return { ok: false, ...failure };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    console.info("[thread-title] attempt", {
      outcome,
      elapsedMs: Date.now() - startedAt,
      ...(finishReason ? { finishReason } : {}),
      ...(tokens !== undefined ? { totalTokens: tokens } : {}),
    });
  }
}
