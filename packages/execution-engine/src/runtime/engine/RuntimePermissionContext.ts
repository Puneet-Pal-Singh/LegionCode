import type { Run } from "../run/index.js";

export function requirePersistedPermissionContext(
  run: Run,
): NonNullable<Run["metadata"]["permissionContext"]> {
  const permissionContext = run.metadata.permissionContext;
  if (!permissionContext) {
    throw new Error(
      `[runtime-kernel/native] Run ${run.id} is missing persisted permission context`,
    );
  }
  return permissionContext;
}
