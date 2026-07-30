import type { LifecycleProjection } from "../../../services/lifecycle/LifecycleProjection";

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
    merged[turnId] = newest;
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
