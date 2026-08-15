export type WriteFilePreflight =
  | { kind: "missing" }
  | { kind: "present"; content: string }
  | { kind: "error"; message: string };

export async function resolveWriteFileExpectedSha256(
  preflight: WriteFilePreflight,
): Promise<string | undefined> {
  // The runtime's preflight is the authoritative file-version observation.
  // Provider-generated hashes are not trustworthy concurrency capabilities.
  if (preflight.kind === "error") {
    throw new WriteFilePreconditionError(preflight.message);
  }
  return preflight.kind === "missing"
    ? undefined
    : await sha256(preflight.content);
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

async function sha256(content: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
