import { createHash } from "node:crypto";
import { z } from "zod";
import { CodexStdioTransport } from "./transport/CodexStdioTransport.js";
import { CodexUsageReader } from "./CodexUsageReader.js";

/** Private selected-key evidence. Compute at trusted connection setup, before
 * admission, from the vault's API-key record. Never bless a runtime-observed key.
 */
export function codexApiKeyIdentityFingerprint(apiKey: string): string {
  if (
    !apiKey ||
    apiKey.length > 65_536 ||
    apiKey.trim() !== apiKey ||
    // This route accepts a key, never a serialized OAuth/vault record.
    /[\s\0{}\[\]"]/u.test(apiKey)
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

  constructor(
    private readonly billingSource: "api_key" | "subscription",
    private readonly identityFingerprint: string,
    environment: Readonly<Record<string, string>>,
    modelProvider: string,
  ) {
    this.apiKey =
      billingSource === "api_key" ? (environment.OPENAI_API_KEY ?? null) : null;
    if (billingSource === "api_key") {
      if (
        modelProvider !== "openai" ||
        !this.apiKey ||
        codexApiKeyIdentityFingerprint(this.apiKey) !== identityFingerprint ||
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
  }

  launchArgs(): readonly string[] {
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

  async establish(transport: CodexStdioTransport): Promise<void> {
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
    // No retry after a lost response. Raw transport errors never include params.
    try {
      const [result] = await Promise.all([
        transport.request("account/login/start", {
          type: "apiKey",
          apiKey: this.apiKey,
        }),
        notifications,
      ]);
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
    if (
      !account.requiresOpenaiAuth ||
      account.route !== this.billingSource ||
      (this.billingSource === "subscription" &&
        (account.identityFingerprint === null ||
          account.identityFingerprint !== this.identityFingerprint))
    )
      throw new Error(
        "Codex account identity or payer differs from selected connection",
      );
    // apiKey carries no account identity in the pinned protocol. Provenance is
    // the prebound key explicitly submitted above, never the observed payer alone.
  }
}
