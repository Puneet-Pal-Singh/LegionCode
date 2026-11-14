import { applyConversationLifecycleRecovery, type LifecycleProjection } from "./conversation-lifecycle-projection.js";

type ProjectionMap = Readonly<Record<string, LifecycleProjection>>;

export function mergeLifecycleProjections(
  replayed: ProjectionMap,
  observed: ProjectionMap,
  active: LifecycleProjection | null,
): ProjectionMap {
  const merged: Record<string, LifecycleProjection> = {};
  const turnIds = new Set([
    ...Object.keys(observed),
    ...Object.keys(replayed),
    ...(active ? [active.turnId] : []),
  ]);

  for (const turnId of turnIds) {
    const candidates = [
      observed[turnId],
      replayed[turnId],
      active?.turnId === turnId ? active : undefined,
    ].filter(
      (candidate): candidate is LifecycleProjection => candidate !== undefined,
    );
    const newest = candidates.reduce((current, candidate) =>
      isProjectionNewer(candidate, current) ? candidate : current,
    );
    // Replay/live transport pages may omit optional recovery metadata. Do not
    // let a newer event snapshot discard known ownership loss for the same
    // attempt; an exact canonical terminal is the only implicit disposition.
    let projection = newest;
    for (const candidate of candidates) {
      const recovery = candidate.recovery;
      if (!recovery) continue;
      const terminal = candidates.find(value => value.terminal &&
        value.runtimeAttempt?.threadId === recovery.threadId &&
        value.runtimeAttempt.runAttemptId === recovery.runAttemptId);
      if (terminal) {
        const attempt = projection.runtimeAttempt;
        if (!attempt || (attempt.threadId === recovery.threadId && attempt.runAttemptId === recovery.runAttemptId)) projection = terminal;
      } else {
        projection = applyConversationLifecycleRecovery(projection, recovery);
      }
    }
    merged[turnId] = projection;
  }

  return merged;
}

function isProjectionNewer(
  candidate: LifecycleProjection,
  current: LifecycleProjection,
): boolean {
  if (candidate.lastSequence !== current.lastSequence) {
    return candidate.lastSequence > current.lastSequence;
  }
  if (Boolean(candidate.terminal) !== Boolean(current.terminal)) {
    return Boolean(candidate.terminal);
  }
  return candidate.items.length >= current.items.length;
}
