import { UserIdSchema, type UserId } from "./ids.js";

/**
 * Maps an authenticated control-plane subject into the canonical opaque
 * protocol ID without allowing a caller to choose another user's scope.
 */
export function userIdFromExternalId(value: string): UserId {
  const existing = UserIdSchema.safeParse(value);
  if (existing.success) return existing.data;

  const sanitized = value
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96);
  const suffix = sanitized.length >= 6 ? sanitized : `${sanitized}000000`;
  return UserIdSchema.parse(`usr_${suffix}`);
}
