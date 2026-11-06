import { CLAUDE_AGENT_SDK_VERSION } from "../settings.js";
import { isAbsolute, normalize, relative, sep } from "node:path";

// Copy transport/runtime necessities, never unrelated provider or cloud auth.
const runtimeEnvironmentKeys = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "SystemRoot",
] as const;

/** Host obtains this value from the selected connection's existing vault. */
export type ClaudeApiKeyCredential = {
  readonly kind: "api-key";
  readonly apiKey: string;
};

export function selectedClaudeEnvironment(input: {
  readonly inherited: Readonly<Record<string, string | undefined>>;
  readonly configDirectory: string;
  readonly credential: ClaudeApiKeyCredential;
}): Readonly<Record<string, string>> {
  const home = input.inherited.HOME;
  const config = normalize(input.configDirectory);
  if (!home || !isAbsolute(home) || !isAbsolute(config)) {
    throw new Error(
      "Claude requires absolute host-owned HOME and config paths",
    );
  }
  const configFromHome = relative(home, config);
  if (
    !configFromHome ||
    configFromHome === ".claude" ||
    configFromHome.startsWith(`.claude${sep}`)
  ) {
    throw new Error("Claude requires an isolated configuration directory");
  }
  if (input.credential.kind !== "api-key" || !input.credential.apiKey.trim()) {
    throw new Error("An explicitly selected Claude API key is required");
  }
  const env: Record<string, string> = {};
  for (const key of runtimeEnvironmentKeys) {
    const value = input.inherited[key];
    if (value !== undefined) env[key] = value;
  }
  env.CLAUDE_CONFIG_DIR = config;
  env.ANTHROPIC_API_KEY = input.credential.apiKey;
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "legioncode";
  // Exact controls introduced by the pinned query() implementation for this runner.
  // Never retain arbitrary CLAUDE_* inherited flags, gateway routing or refresh hooks.
  env.CLAUDE_CODE_ENTRYPOINT = "sdk-ts";
  env.CLAUDE_AGENT_SDK_VERSION = CLAUDE_AGENT_SDK_VERSION;
  env.CLAUDE_CODE_SDK_READS_SESSION_STATE = "1";
  return Object.freeze(env);
}

/** Rebuild at the final launch boundary, even if upstream reintroduces ambient variables. */
export function frozenClaudeLaunchEnvironment(
  selected: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  return selectedClaudeEnvironment({
    inherited: selected,
    configDirectory: selected.CLAUDE_CONFIG_DIR ?? "",
    credential: { kind: "api-key", apiKey: selected.ANTHROPIC_API_KEY ?? "" },
  });
}
