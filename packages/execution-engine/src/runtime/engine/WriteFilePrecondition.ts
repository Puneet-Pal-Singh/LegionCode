export type WriteFilePreflight =
  | { kind: "missing" }
  | { kind: "present"; content: string }
  | { kind: "error"; message: string };

export function resolveWriteFileExpectedSha256(
  preflight: WriteFilePreflight,
  requestedExpectedSha256: string | undefined,
): string | undefined {
  // A hash guard describes a prior file version. Providers occasionally
  // synthesize one for a creation request; the runtime's preflight read is the
  // authoritative distinction between creation and replacement.
  if (preflight.kind === "error") {
    throw new WriteFilePreconditionError(preflight.message);
  }
  return preflight.kind === "missing" ? undefined : requestedExpectedSha256;
}

export class WriteFilePreconditionError extends Error {
  constructor(message: string) {
    super(`Unable to verify write target: ${message}`);
    this.name = "WriteFilePreconditionError";
  }
}

export function classifyWriteFilePreflightFailure(
  message: string,
): WriteFilePreflight {
  return looksLikeMissingTargetError(message)
    ? { kind: "missing" }
    : { kind: "error", message };
}

function looksLikeMissingTargetError(message: string): boolean {
  return /no such file(?: or directory)?|file(?: was)? not found|path .* not found|file does not exist/i.test(
    message,
  );
}
