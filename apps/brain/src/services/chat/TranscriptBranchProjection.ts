import type { TranscriptMessageRecord } from "@repo/persistence";

/**
 * Projects the active transcript branch while retaining superseded records in
 * durable storage for audit and replay.
 */
export function projectActiveTranscriptBranch(
  messages: readonly TranscriptMessageRecord[],
  additionalSupersededTurnIds: readonly string[] = [],
): TranscriptMessageRecord[] {
  const supersededTurnIds = new Set(additionalSupersededTurnIds);
  for (const message of messages) {
    const revisionOfTurnId = readCanonicalIdentityField(
      message,
      "revisionOfTurnId",
    );
    if (revisionOfTurnId) supersededTurnIds.add(revisionOfTurnId);
  }
  return messages.filter((message) => {
    const turnId = readCanonicalIdentityField(message, "turnId");
    return !turnId || !supersededTurnIds.has(turnId);
  });
}

export function readCanonicalIdentityField(
  message: TranscriptMessageRecord,
  field: "turnId" | "revisionOfTurnId",
): string | null {
  for (const part of message.parts) {
    if (
      part.type !== "text" ||
      !part.content ||
      typeof part.content !== "object"
    ) {
      continue;
    }
    const content = part.content as Record<string, unknown>;
    const metadata = readRecord(content.metadata);
    const identity = readRecord(metadata?.canonicalIdentity);
    const value = identity?.[field];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
