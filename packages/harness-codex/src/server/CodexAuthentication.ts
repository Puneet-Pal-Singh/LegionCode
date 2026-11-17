import { createHash } from "node:crypto";
import { z } from "zod";
import type { HarnessInstanceScope } from "@repo/harness-core/server";
import type { HarnessSelection } from "@repo/platform-protocol";
import type { RuntimeCredentialReference } from "@repo/platform-protocol/private/runtime-credential-reference";
import { CodexStdioTransport } from "./transport/CodexStdioTransport.js";
import { CodexUsageReader } from "./CodexUsageReader.js";

const chatgptPlanProvider = "openai_chatgpt_plan";

/** Supplied by the private composition that owns verified OAuth and admission. */
export interface CodexAppManagedSubscriptionBinding {
  readonly kind: "app_managed_chatgpt";
  readonly scope: Readonly<HarnessInstanceScope>;
  readonly credentialReference: Readonly<RuntimeCredentialReference>;
  readonly identityFingerprint: string;
  /** SHA-256 hex digest of the exact access token selected for this host. */
  readonly accessTokenFingerprint: string;
  /** Unix time in milliseconds, from verified OAuth custody. */
  readonly expiresAt: number;
  /** Check live admission and custody for this exact binding and process. */
  readonly assertCurrent: (input: {
    readonly selection: HarnessSelection;
    readonly credentialReference: Readonly<RuntimeCredentialReference>;
    readonly identityFingerprint: string;
    readonly accessTokenFingerprint: string;
    readonly expiresAt: number;
    readonly processGeneration: string;
    readonly signal: AbortSignal;
  }) => Promise<{
    /** Invalidated synchronously when the selected owner or material changes. */
    readonly canDeliver: () => boolean;
  }>;
}

/** Private selected API-key evidence from one admission/custody acquisition. */
export interface CodexApiKeyBinding {
  readonly kind: "api_key";
  readonly scope: Readonly<HarnessInstanceScope>;
  readonly credentialReference: Readonly<RuntimeCredentialReference>;
  readonly identityFingerprint: string;
  /** Raw SHA-256 of the same selected key; distinct from identityFingerprint. */
  readonly keyMaterialSha256: string;
  readonly expiresAt: number | null;
  /** Attest the exact reference/material and synchronously invalidate the lease
   * on rotation, revoke or owner loss. The host must fence physical dispatch. */
  readonly assertCurrent: (input: {
    readonly selection: HarnessSelection;
    readonly credentialReference: Readonly<RuntimeCredentialReference>;
    readonly identityFingerprint: string;
    readonly keyMaterialSha256: string;
    readonly expiresAt: number | null;
    readonly processGeneration: string;
    readonly signal: AbortSignal;
  }) => Promise<{ readonly canDeliver: () => boolean }>;
}

type CodexCustodyCheck = Pick<
  Parameters<CodexAppManagedSubscriptionBinding["assertCurrent"]>[0],
  "selection" | "processGeneration" | "signal"
>;
type CodexCustodyLease = Awaited<
  ReturnType<CodexAppManagedSubscriptionBinding["assertCurrent"]>
>;

type CodexAuthenticationRoute =
  | {
      readonly kind: "cli_managed_chatgpt";
      readonly identityFingerprint: string;
    }
  | CodexApiKeyBinding
  | CodexAppManagedSubscriptionBinding;

/** Private selected-key evidence. Compute at trusted connection setup, before
 * admission, from the vault's API-key record. Never bless a runtime-observed key.
 */
export function codexApiKeyIdentityFingerprint(apiKey: string): string {
  if (
    !apiKey ||
    apiKey.length > 65_536 ||
    apiKey.trim() !== apiKey ||
    // This route accepts a key, never a serialized OAuth/vault record.
    /[\s\0{}[\]"]/u.test(apiKey)
  )
    throw new Error("Invalid selected Codex API key");
  return createHash("sha256")
    .update(
      JSON.stringify({ source: "codex-selected-api-key-0.167.0", apiKey }),
    )
    .digest("hex");
}

/** Payer translation only. The host retains credential custody and generation
 * fencing; this object cannot select another connection or refresh credentials.
 */
export class CodexAuthentication {
  private readonly apiKey: string | null;
  private loginSubmitted = false;
  private established = false;
  private pendingLogin: {
    completed: boolean;
    resolve(): void;
    reject(error: Error): void;
  } | null = null;
  readonly modelProvider: string;

  constructor(
    private readonly route: CodexAuthenticationRoute,
    environment: Readonly<Record<string, string>>,
    modelProvider: string,
  ) {
    this.modelProvider = this.appManaged ? chatgptPlanProvider : modelProvider;
    this.apiKey =
      route.kind === "api_key" ? (environment.OPENAI_API_KEY ?? null) : null;
    if (
      !this.appManaged &&
      (environment.ACCESS_TOKEN || modelProvider === chatgptPlanProvider)
    )
      throw new Error(
        "Codex authentication binding contains alternate credentials",
      );
    if (route.kind === "api_key") {
      if (
        modelProvider !== "openai" ||
        !this.apiKey ||
        codexApiKeyIdentityFingerprint(this.apiKey) !==
          route.identityFingerprint ||
        !/^[a-f0-9]{64}$/.test(route.keyMaterialSha256) ||
        createHash("sha256").update(this.apiKey).digest("hex") !==
          route.keyMaterialSha256 ||
        [
          "CODEX_API_KEY",
          "AZURE_OPENAI_API_KEY",
          "CODEX_ACCESS_TOKEN",
          "OPENAI_BASE_URL",
          "OPENAI_ORGANIZATION",
          "OPENAI_PROJECT",
        ].some((name) => Boolean(environment[name]))
      )
        throw new Error("Codex selected API-key binding unavailable");
    } else if (
      [
        "OPENAI_API_KEY",
        "CODEX_API_KEY",
        "AZURE_OPENAI_API_KEY",
        "CODEX_ACCESS_TOKEN",
      ].some((name) => Boolean(environment[name]))
    ) {
      throw new Error(
        "Codex subscription binding contains alternate credentials",
      );
    }
    if (route.kind === "app_managed_chatgpt") {
      const token = environment.ACCESS_TOKEN;
      if (
        !token ||
        token.length > 65_536 ||
        !/^[A-Za-z0-9._~+/-]+=*$/.test(token) ||
        createHash("sha256").update(token).digest("hex") !==
          route.accessTokenFingerprint
      )
        throw new Error("Codex app-managed token binding unavailable");
    }
  }

  get appManaged(): boolean {
    return this.route.kind === "app_managed_chatgpt";
  }

  get requiresCustody(): boolean {
    return this.route.kind !== "cli_managed_chatgpt";
  }

  async assertCurrent(
    input: CodexCustodyCheck,
  ): Promise<CodexCustodyLease | undefined> {
    const route = this.route;
    if (route.kind === "cli_managed_chatgpt") return;
    this.assertNotExpired(input.signal);
    try {
      const common = Object.freeze({
        ...input,
        credentialReference: route.credentialReference,
        identityFingerprint: route.identityFingerprint,
      });
      const lease =
        route.kind === "api_key"
          ? await route.assertCurrent(
              Object.freeze({
                ...common,
                keyMaterialSha256: route.keyMaterialSha256,
                expiresAt: route.expiresAt,
              }),
            )
          : await route.assertCurrent(
              Object.freeze({
                ...common,
                accessTokenFingerprint: route.accessTokenFingerprint,
                expiresAt: route.expiresAt,
              }),
            );
      this.assertUsable(input.signal, lease);
      return lease;
    } catch {
      throw new Error("Codex selected custody unavailable");
    }
  }

  assertUsable(
    signal: AbortSignal,
    lease: CodexCustodyLease | undefined,
  ): void {
    if (!this.requiresCustody) return;
    this.assertNotExpired(signal);
    try {
      if (lease?.canDeliver() === true) return;
    } catch {
      // Custody diagnostics may carry private material.
    }
    throw new Error("Codex selected custody expired or fenced");
  }

  private assertNotExpired(signal: AbortSignal): void {
    const route = this.route;
    if (route.kind === "cli_managed_chatgpt") return;
    if (
      signal.aborted ||
      (route.expiresAt === null
        ? route.kind !== "api_key"
        : !Number.isSafeInteger(route.expiresAt) ||
          Date.now() >= route.expiresAt)
    )
      throw new Error("Codex selected custody expired or fenced");
  }

  launchArgs(): readonly string[] {
    if (this.appManaged) {
      return [
        "app-server",
        "--listen",
        "stdio://",
        "-c",
        `model_provider="${chatgptPlanProvider}"`,
        "-c",
        `model_providers.${chatgptPlanProvider}={name="ChatGPT plan",base_url="https://api.openai.com/v1",env_key="ACCESS_TOKEN",wire_api="responses",requires_openai_auth=false,supports_websockets=false}`,
        "-c",
        'cli_auth_credentials_store="ephemeral"',
        "-c",
        'shell_environment_policy.filters.ACCESS_TOKEN="exclude"',
      ];
    }
    if (this.apiKey === null) return ["app-server"];
    // 0.167 app-server deliberately disables ambient CODEX_API_KEY auth.
    // Its supported API-key login stores only in this process, never auth.json.
    // All overrides are non-secret and precede initialize/account/model startup.
    return [
      "app-server",
      "-c",
      'model_provider="openai"',
      "-c",
      'openai_base_url="https://api.openai.com/v1"',
      "-c",
      'cli_auth_credentials_store="ephemeral"',
      "-c",
      'forced_login_method="api"',
    ];
  }

  async establish(
    transport: CodexStdioTransport,
    assertCurrent: () => void,
  ): Promise<void> {
    assertCurrent();
    if (this.loginSubmitted)
      throw new Error("Codex authentication already submitted");
    this.loginSubmitted = true;
    if (this.apiKey === null) {
      this.established = true;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const notifications = new Promise<void>((resolve, reject) => {
      this.pendingLogin = { completed: false, resolve, reject };
      timer = setTimeout(() => this.cancel(), 30_000);
      timer.unref();
    });
    // Custody can fail before Promise.all starts observing the login pair.
    void notifications.catch(() => undefined);
    // No retry after a lost response. Raw transport errors never include params.
    try {
      assertCurrent();
      const [result] = await Promise.all([
        transport.request("account/login/start", {
          type: "apiKey",
          apiKey: this.apiKey,
        }),
        notifications,
      ]);
      assertCurrent();
      if (!z.object({ type: z.literal("apiKey") }).safeParse(result).success)
        throw new Error("Codex selected API-key login unavailable");
      this.established = true;
    } finally {
      if (timer) clearTimeout(timer);
      this.cancel();
    }
  }

  /** 0.167 sends login/completed then account/updated AFTER the RPC result.
   * Drain that exact pair before enforcing steady-state account-change fencing.
   */
  observeNotification(method: string, raw: unknown): boolean {
    const pending = this.pendingLogin;
    if (!pending) return false;
    if (method === "account/login/completed") {
      if (
        pending.completed ||
        !z
          .object({ loginId: z.null(), success: z.literal(true) })
          .safeParse(raw).success
      )
        throw new Error("Codex selected API-key login unavailable");
      pending.completed = true;
      return true;
    }
    if (method === "account/updated") {
      if (
        !pending.completed ||
        !z
          .object({ authMode: z.literal("apikey"), planType: z.null() })
          .safeParse(raw).success
      )
        throw new Error("Codex selected API-key login unavailable");
      this.pendingLogin = null;
      pending.resolve();
      return true;
    }
    if (method === "account/gatewayOAuth/changed")
      throw new Error("Codex selected API-key login unavailable");
    return false;
  }

  cancel(): void {
    const pending = this.pendingLogin;
    this.pendingLogin = null;
    pending?.reject(new Error("Codex selected API-key login unavailable"));
  }

  async verify(reader: CodexUsageReader): Promise<void> {
    if (!this.established)
      throw new Error("Codex authentication not established");
    const account = await reader.account();
    if (this.route.kind === "app_managed_chatgpt") {
      if (account.requiresOpenaiAuth || account.hasNativeAccount)
        throw new Error("Codex app-managed payer configuration unavailable");
      return;
    }
    if (
      !account.requiresOpenaiAuth ||
      account.route !==
        (this.route.kind === "api_key" ? "api_key" : "subscription") ||
      (this.route.kind === "cli_managed_chatgpt" &&
        (account.identityFingerprint === null ||
          account.identityFingerprint !== this.route.identityFingerprint))
    )
      throw new Error(
        "Codex account identity or payer differs from selected connection",
      );
    // apiKey carries no account identity in the pinned protocol. Provenance is
    // the prebound key explicitly submitted above, never the observed payer alone.
  }
}
