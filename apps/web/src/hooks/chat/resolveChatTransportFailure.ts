import type {
  LifecycleClient,
  TurnId,
} from "../../services/api/lifecycleClient";
import type { ConversationScope } from "../conversationScope";

const DEFAULT_CANONICAL_EVIDENCE_TIMEOUT_MS = 2_000;

/**
 * A chat HTTP connection is only a submission transport. A failure is
 * accepted only when replay proves the exact reserved thread, turn and attempt.
 */
export async function hasCanonicalLifecycleEvidence(
  lifecycleClient: LifecycleClient,
  scope: ConversationScope,
  timeoutMs = DEFAULT_CANONICAL_EVIDENCE_TIMEOUT_MS,
): Promise<boolean> {
  const abortController = new AbortController();
  let timeoutResolver: (() => void) | null = null;
  const timeoutPromise = new Promise<null>((resolve) => {
    timeoutResolver = () => resolve(null);
  });
  const timeoutId = window.setTimeout(() => {
    abortController.abort("Canonical lifecycle evidence timed out.");
    timeoutResolver?.();
  }, timeoutMs);
  let iterator: AsyncIterator<import("../../services/api/lifecycleClient").LifecycleEvent> | null = null;

  try {
    const stream = lifecycleClient.followTurnLifecycle(
      { turnId: scope.turnId as TurnId },
      { signal: abortController.signal },
    );
    iterator = stream[Symbol.asyncIterator]();
    while (true) {
      const next = await Promise.race([iterator.next(), timeoutPromise]);
      if (next === null || next.done) return false;
      if (
        next.value.threadId === scope.threadId &&
        next.value.turnId === scope.turnId &&
        next.value.runAttemptId === scope.runAttemptId
      ) {
        return true;
      }
    }
  } catch {
    return false;
  } finally {
    window.clearTimeout(timeoutId);
    abortController.abort("Canonical lifecycle evidence check settled.");
    if (iterator?.return) {
      void Promise.resolve(iterator.return()).catch(() => undefined);
    }
  }
}
