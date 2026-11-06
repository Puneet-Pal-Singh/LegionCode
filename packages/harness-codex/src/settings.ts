/** The transport is fixed for an instance; recovery never switches families. */
export const codexTransportFamily = "codex-app-server-stdio" as const;

/** Binary/schema pins only: neither platform has OS-policy or installed-feature acceptance here. */
export const codexPinnedRuntimePlatforms = [
  "linux-x64",
  "darwin-arm64",
] as const;
export const codexUnavailableRuntimePlatforms = Object.freeze({
  "darwin-x64": "unverified_binary_and_schema",
} as const);
