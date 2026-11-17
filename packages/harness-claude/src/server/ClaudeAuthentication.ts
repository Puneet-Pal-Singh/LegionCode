import { createHash } from "node:crypto";
import type {
  HarnessHost,
  HarnessInstanceScope,
} from "@repo/harness-core/server";
import {
  RuntimeCredentialReferenceSchema,
  type RuntimeCredentialReference,
} from "@repo/platform-protocol/private/runtime-credential-reference";
import type { HarnessStartCommand } from "@repo/worker-protocol";
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
  "TZ",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
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
  // The SDK filters sdk_host_only state frames. Explicit public state events are
  // required for our native idle wait (verified in pinned CLI + SDK source).
  env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = "1";
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

/** Host custody must synchronously invalidate this lease on revoke, rotation or owner loss. */
export interface ClaudeSelectedAccountLease {
  readonly canDeliver: () => boolean;
}

/** Private API-key engineering binding, supplied before admission by the custody owner. */
export interface ClaudeSelectedAccountBinding {
  readonly scope: Readonly<HarnessInstanceScope>;
  readonly credentialReference: Readonly<RuntimeCredentialReference>;
  /** SHA-256 of exact selected key bytes, distinct from a custody identity fingerprint. */
  readonly fingerprint: string;
  readonly expiresAt: number | null;
  /** Revalidate the exact token material version. The host must also fence its
   * physical launch/process boundary when custody invalidates this lease. */
  readonly assertCurrent: (input: {
    readonly selection: HarnessStartCommand["selection"];
    readonly credentialReference: Readonly<RuntimeCredentialReference>;
    readonly fingerprint: string;
    readonly expiresAt: number | null;
    readonly processGeneration: string;
    readonly signal: AbortSignal;
  }) => Promise<ClaudeSelectedAccountLease>;
}

const accountScopeFields = [
  "userId",
  "workspaceId",
  "environmentId",
  "workspaceGrantId",
  "harness",
  "instanceId",
  "connectionId",
  "authOwnerGeneration",
  "runtimeVersion",
  "protocolVersion",
  "transport",
] as const satisfies readonly (keyof HarnessInstanceScope)[];

/** Checks custody at each native continuation boundary; owns no credential store. */
export class ClaudeSelectedAccountGuard {
  private readonly binding: ClaudeSelectedAccountBinding;
  private readonly processGeneration: string;
  private readonly selection: HarnessStartCommand["selection"];

  constructor(
    binding: ClaudeSelectedAccountBinding,
    command: HarnessStartCommand,
    private readonly host: HarnessHost,
    private readonly openingSignal: AbortSignal,
  ) {
    const reference = RuntimeCredentialReferenceSchema.parse(
      binding?.credentialReference,
    );
    if (
      command.selection.billingSource !== "api_key" ||
      command.selection.harness !== "claude" ||
      !binding.scope ||
      accountScopeFields.some(
        (field) => binding.scope[field] !== command.selection[field],
      ) ||
      reference.connectionId !== command.selection.connectionId ||
      reference.providerId !== "anthropic" ||
      reference.ownerGeneration !== command.selection.authOwnerGeneration ||
      !/^[a-f0-9]{64}$/.test(binding.fingerprint) ||
      (binding.expiresAt !== null &&
        !Number.isSafeInteger(binding.expiresAt)) ||
      typeof binding.assertCurrent !== "function"
    )
      throw new Error("Claude selected account binding unavailable");
    this.binding = Object.freeze({
      ...binding,
      scope: Object.freeze({ ...binding.scope }),
      credentialReference: Object.freeze(reference),
    });
    this.selection = Object.freeze({ ...command.selection });
    this.processGeneration = host.processGeneration;
    this.assertScope(openingSignal);
  }

  async authorize(signal: AbortSignal): Promise<() => void> {
    this.assertScope(signal);
    const { binding } = this;
    const lease = await binding.assertCurrent(
      Object.freeze({
        selection: this.selection,
        credentialReference: binding.credentialReference,
        fingerprint: binding.fingerprint,
        expiresAt: binding.expiresAt,
        processGeneration: this.processGeneration,
        signal,
      }),
    );
    const assertDeliverable = () => {
      this.assertScope(signal);
      if (
        !lease ||
        typeof lease.canDeliver !== "function" ||
        lease.canDeliver() !== true
      )
        throw new Error("Claude selected account lease fenced");
    };
    assertDeliverable();
    return assertDeliverable;
  }

  private assertScope(signal: AbortSignal): void {
    const key = this.host.environment.ANTHROPIC_API_KEY;
    if (
      this.openingSignal.aborted ||
      signal.aborted ||
      this.host.processGeneration !== this.processGeneration ||
      (this.binding.expiresAt !== null &&
        Date.now() >= this.binding.expiresAt) ||
      !key ||
      key.length > 65_536 ||
      /[\s\0]/u.test(key) ||
      createHash("sha256").update(key).digest("hex") !==
        this.binding.fingerprint
    )
      throw new Error("Claude selected account authority unavailable");
  }
}
