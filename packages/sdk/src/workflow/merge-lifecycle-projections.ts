import { applyConversationLifecycleRecovery, type LifecycleProjection } from "./conversation-lifecycle-projection.js";
import { sameLifecycleAttempt } from "./lifecycle-attempt.js";

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
    const activeProjection = active?.turnId === turnId ? active : undefined;
    const snapshots = [
      observed[turnId],
      replayed[turnId],
      activeProjection,
    ].filter(
      (candidate): candidate is LifecycleProjection => candidate !== undefined,
    );
    // Retained/live identity precedes historical replay across reader retries.
    // Recovery pins the same tuple when canonical events have not arrived yet.
    const attempt = observed[turnId]?.runtimeAttempt ?? observed[turnId]?.recovery ??
      activeProjection?.runtimeAttempt ?? activeProjection?.recovery ??
      replayed[turnId]?.runtimeAttempt ?? replayed[turnId]?.recovery;
    const candidates = attempt ? snapshots.filter(candidate => {
      const captured = candidate.runtimeAttempt ?? candidate.recovery;
      return captured && sameLifecycleAttempt(captured, attempt);
    }) : snapshots;
    const newest = candidates.reduce((current, candidate) =>
      isProjectionNewer(candidate, current) ? candidate : current,
    );
    // Replay/live transport pages may omit optional recovery metadata. Do not
    // let a newer event snapshot discard known ownership loss for the same
    // attempt; an exact canonical terminal is the only implicit disposition.
    let projection = newest;
    for (const candidate of candidates) {
      const recovery = candidate.recovery;
      if (!recovery || (attempt && !sameLifecycleAttempt(recovery, attempt))) continue;
      const terminal = candidates.find(value => value.terminal &&
        value.runtimeAttempt && sameLifecycleAttempt(value.runtimeAttempt, recovery));
      if (terminal) {
        const projectionAttempt = projection.runtimeAttempt;
        if (!projectionAttempt || sameLifecycleAttempt(projectionAttempt, recovery)) projection = terminal;
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
