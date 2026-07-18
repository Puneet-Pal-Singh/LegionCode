import { WorkspaceIdSchema, type WorkspaceId } from "./ids.js";

/**
 * Maps a control-plane workspace identifier into the canonical protocol ID
 * used by runtime manifests and secure execution scopes.
 */
export function workspaceIdFromExternalId(value: string): WorkspaceId {
  const existing = WorkspaceIdSchema.safeParse(value);
  if (existing.success) {
    return existing.data;
  }

  const sanitized = value
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96);
  const suffix = sanitized.length >= 6 ? sanitized : `${sanitized}000000`;
  return WorkspaceIdSchema.parse(`wrk_${suffix}`);
}
