import {
  projectVisibleTranscriptText,
  type TranscriptPart,
} from "@repo/platform-protocol";

/**
 * A provider may return only quarantined transcript material. The native
 * runtime gets one final-only retry, but never converts private material into
 * a user-visible answer and never retries a real tool response.
 */
export function shouldRetryNativeFinalOnlyResponse(input: {
  readonly recoveryAttemptCount: number;
  readonly toolCallCount: number;
  readonly responseParts: readonly TranscriptPart[];
}): boolean {
  return (
    input.recoveryAttemptCount < 2 &&
    input.toolCallCount === 0 &&
    !projectVisibleTranscriptText(input.responseParts).trim()
  );
}
