import type {
  LifecycleClient,
  TurnId,
} from "../../services/api/lifecycleClient";

const DEFAULT_CANONICAL_EVIDENCE_TIMEOUT_MS = 2_000;

/**
 * A chat HTTP connection is only a submission transport. Once the canonical
 * lifecycle contains an event for the turn, replay owns the product state and
 * a detached chat response must not turn an accepted run into a UI failure.
 */
export async function hasCanonicalLifecycleEvidence(
  lifecycleClient: LifecycleClient,
  turnId: TurnId,
  timeoutMs = DEFAULT_CANONICAL_EVIDENCE_TIMEOUT_MS,
): Promise<boolean> {
  const abortController = new AbortController();
  const timeoutId = window.setTimeout(
    () => abortController.abort("Canonical lifecycle evidence timed out."),
    timeoutMs,
  );
  const iterator = lifecycleClient
    .followTurnLifecycle(
      { turnId },
      { signal: abortController.signal },
    )
    [Symbol.asyncIterator]();

  try {
    const first = await iterator.next();
    return !first.done;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timeoutId);
    try {
      await iterator.return?.();
    } catch {
      // The abort signal is the authoritative iterator cleanup mechanism.
    }
  }
}
