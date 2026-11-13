/** Product, protocol and Promise client are a single reviewed compatibility family. */
export const OPENCODE_VERSION = "2.2.5";
export const OPENCODE_TRANSPORT = "opencode_v2";
// npm 2.2.5 provenance reports release.yml run 41135857908 as this source.
// Historical research revisions and verification limits remain in the transport decision.
export const OPENCODE_SOURCE_REVISION =
  "958f965d35ed44d32b018fd55b02a5357a7748fd";

export function requireOpenCodeVersion(
  version: string,
): typeof OPENCODE_VERSION {
  if (version.trim() !== OPENCODE_VERSION) {
    throw new Error(
      "OpenCode installation is incompatible; version 2.2.5 is required.",
    );
  }
  return OPENCODE_VERSION;
}

/** Host supervisor owns execution of this argument vector, without a shell. */
export const OPENCODE_SERVER_ARGUMENTS = Object.freeze([
  "serve",
  "--stdio",
  "--hostname=127.0.0.1",
  "--port=0",
]);

export function readOpenCodeServerUrl(line: string): string {
  if (line.length > 4096)
    throw new Error("Invalid OpenCode server announcement.");
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("Invalid OpenCode server announcement.");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("url" in value) ||
    typeof value.url !== "string"
  ) {
    throw new Error("Invalid OpenCode server announcement.");
  }
  return requirePrivateOpenCodeUrl(value.url);
}

export function requirePrivateOpenCodeUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid OpenCode server address.");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "OpenCode must use an authenticated private loopback server.",
    );
  }
  return url.origin;
}

/** Exact stdout of the pinned published CLI; no v1 or range acceptance. */
export function verifyOpenCodeProbe(stdout: string): typeof OPENCODE_VERSION {
  if (stdout.trim() !== `opencode v${OPENCODE_VERSION}`) {
    throw new Error(
      "OpenCode binary probe is incompatible; version 2.2.5 is required.",
    );
  }
  return OPENCODE_VERSION;
}
