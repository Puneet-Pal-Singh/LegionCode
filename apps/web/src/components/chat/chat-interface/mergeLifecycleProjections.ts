import type { LifecycleProjection } from "../../../services/lifecycle/LifecycleProjection";

type ProjectionMap = Readonly<Record<string, LifecycleProjection>>;

export function mergeLifecycleProjections(
  replayed: ProjectionMap,
  observed: ProjectionMap,
  active: LifecycleProjection | null,
): ProjectionMap {
  return {
    ...observed,
    ...replayed,
    ...(active ? { [active.turnId]: active } : {}),
  };
}
