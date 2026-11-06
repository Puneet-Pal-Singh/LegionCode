/** The transport is fixed for an instance; recovery never switches families. */
export const codexTransportFamily = "codex-app-server-stdio" as const;

/** A pin alone is not product acceptance. Darwin stays unavailable until its binary/schema proof. */
export const codexPinnedRuntimePlatforms = ["linux-x64"] as const;
export const codexUnavailableRuntimePlatforms = Object.freeze({
  "darwin-arm64": "unverified_binary_and_schema",
  "darwin-x64": "unverified_binary_and_schema",
} as const);
