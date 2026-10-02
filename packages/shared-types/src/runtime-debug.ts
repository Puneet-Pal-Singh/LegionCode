export interface RuntimeIdentity {
  bootId: string;
  name: string;
  startedAt: string;
}

export type RuntimeHeaders = Record<string, string>;

const GIT_SHA_ENV_KEYS = [
  "RUNTIME_GIT_SHA",
  "CF_PAGES_COMMIT_SHA",
  "GITHUB_SHA",
] as const;

export function createRuntimeIdentity(
  name: string,
  startedAt: string = new Date().toISOString(),
): RuntimeIdentity {
  return {
    bootId: crypto.randomUUID(),
    name,
    startedAt,
  };
}

export function resolveRuntimeGitSha(source: Record<string, unknown>): string {
  for (const key of GIT_SHA_ENV_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return "unconfigured";
}

export function collectFeatureFlagSnapshot(
  source: Record<string, unknown>,
): Record<string, string> {
  const entries = Object.entries(source)
    .filter(
      ([key, value]) =>
        key.startsWith("FEATURE_FLAG_") &&
        typeof value === "string" &&
        value.trim().length > 0,
    )
    .sort(([left], [right]) => left.localeCompare(right));

  return Object.fromEntries(entries) as Record<string, string>;
}

export function buildRuntimeFingerprint(
  identity: RuntimeIdentity,
  gitSha: string,
): string {
  return `${identity.name}:${gitSha}:${identity.bootId}`;
}

export function buildRuntimeHeaders(
  identity: RuntimeIdentity,
  source: Record<string, unknown>,
): RuntimeHeaders {
  const gitSha = resolveRuntimeGitSha(source);

  return {
    "X-LegionCode-Runtime-Boot-Id": identity.bootId,
    "X-LegionCode-Runtime-Fingerprint": buildRuntimeFingerprint(
      identity,
      gitSha,
    ),
    "X-LegionCode-Runtime-Git-Sha": gitSha,
    "X-LegionCode-Runtime-Name": identity.name,
    "X-LegionCode-Runtime-Started-At": identity.startedAt,
  };
}
