import { EventScopeTypeSchema } from "@repo/platform-protocol";

export const CANONICAL_EVENT_SCOPE_TYPES = EventScopeTypeSchema.options;

export type CanonicalEventScopeType =
  (typeof CANONICAL_EVENT_SCOPE_TYPES)[number];

export function buildCanonicalEventScopeTypeSqlList(): string {
  return CANONICAL_EVENT_SCOPE_TYPES.map(quoteSqlLiteral).join(", ");
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
