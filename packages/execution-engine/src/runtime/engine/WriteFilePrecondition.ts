export function resolveWriteFileExpectedSha256(
  existingContent: string | null,
  requestedExpectedSha256: string | undefined,
): string | undefined {
  // A hash guard describes a prior file version. Providers occasionally
  // synthesize one for a creation request; the runtime's preflight read is the
  // authoritative distinction between creation and replacement.
  return existingContent === null ? undefined : requestedExpectedSha256;
}
