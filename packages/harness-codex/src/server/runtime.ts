import manifest from "../runtime-manifest.json" with { type: "json" };

const platforms = Object.freeze({
  "linux-x64": Object.freeze(manifest.platforms["linux-x64"]),
  "darwin-arm64": Object.freeze(manifest.platforms["darwin-arm64"]),
});

/** Binary/schema evidence only. Host policy and installed product acceptance remain separate gates. */
export const codexRuntime = Object.freeze({
  version: manifest.version,
  transport: manifest.transport,
  schemaSha256: manifest.schemaSha256,
  platforms,
  linuxX64BinarySha256: platforms["linux-x64"].binarySha256,
  npmPackage: platforms["linux-x64"].npmPackage,
  npmIntegrity: platforms["linux-x64"].npmIntegrity,
  // Resume still requires the exact admitted version/schema and canonical generation binding.
  resumeCompatibility: "exact-version-and-schema-only",
  experimentalApi: false,
} as const);

/** Never use a different architecture, an ambient executable or a previous CLI version. */
export function codexRuntimePin(platform: string, architecture: string) {
  const key = `${platform}-${architecture}`;
  if (key === "linux-x64" || key === "darwin-arm64") return platforms[key];
  throw new Error("Codex binary/schema pin unavailable for this platform");
}
