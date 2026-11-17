import { createHash, randomBytes } from "node:crypto";
import { Credential } from "@opencode/schema/credential";
import { Integration } from "@opencode/schema/integration";
import { Location } from "@opencode/schema/location";
import { Model } from "@opencode/schema/model";
import { Provider } from "@opencode/schema/provider";
import type { ModelRef } from "@opencode/client";
import { Schema } from "effect";
import type {
  HarnessHost,
  HarnessInstanceScope,
} from "@repo/harness-core/server";
import {
  RuntimeCredentialReferenceSchema,
  type RuntimeCredentialReference,
} from "@repo/platform-protocol/private/runtime-credential-reference";
import type { HarnessStartCommand } from "@repo/worker-protocol";
import type { OpenCodeClient } from "./OpenCodeClient.js";

type Selection = HarnessStartCommand["selection"];
type PayerSource =
  | Readonly<{ kind: "api_key_env"; name: string }>
  | Readonly<{
      kind: "native_credential";
      id: string;
      method: "key" | "oauth" | "external";
    }>;

export interface OpenCodePayerLease {
  readonly canDeliver: () => boolean;
}

/** Private host composition supplies verified custody and enforceable payer policy. */
export interface OpenCodeSelectedPayerBinding {
  readonly scope: Readonly<HarnessInstanceScope>;
  readonly credentialReference: Readonly<RuntimeCredentialReference>;
  readonly providerID: string;
  readonly integrationID: string;
  readonly source: PayerSource;
  /** SHA-256 hex of the exact selected key bytes. */
  readonly fingerprint: string;
  readonly expiresAt: number | null;
  readonly assertCurrent: (input: {
    readonly selection: Selection;
    readonly credentialReference: Readonly<RuntimeCredentialReference>;
    readonly providerID: string;
    readonly integrationID: string;
    readonly source: PayerSource;
    readonly fingerprint: string;
    readonly expiresAt: number | null;
    readonly processGeneration: string;
    readonly signal: AbortSignal;
  }) => Promise<OpenCodePayerLease>;
  /** Attest the actual effective route, including provider/model overlays and
   * agent, plugin and descendant hooks. The host must fence changes at dispatch. */
  readonly assertEffectivePayer: (input: {
    readonly command: HarnessStartCommand;
    readonly host: HarnessHost;
    readonly model: Readonly<ModelRef>;
    readonly agent: string | undefined;
    readonly binding: OpenCodeSelectedPayerBinding;
    readonly externalSessionId: string | null;
    readonly signal: AbortSignal;
  }) => Promise<void>;
}

export type OpenCodePayerTarget = Readonly<{
  providerID: string;
  integrationID: string;
  directory: string;
}>;

export type OpenCodePayerInspection = Readonly<{
  source: PayerSource;
  connectionCount: number;
  storedCredentialCount: number;
}>;

const scopeFields = [
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

const validProvider = Schema.is(
  Schema.toEncoded(Location.response(Provider.Info)),
);
const validIntegration = Schema.is(
  Schema.toEncoded(Location.response(Integration.Info)),
);
const validCredentials = Schema.is(
  Schema.toEncoded(Schema.Array(Credential.Entry)),
);
const validModel = Schema.is(Schema.toEncoded(Model.Ref));

/** The native credential list includes secrets. Project only routing metadata. */
export function inspectOpenCodePayer(
  target: OpenCodePayerTarget,
  provider: unknown,
  integration: unknown,
  credentials: unknown,
): OpenCodePayerInspection {
  if (
    !validProvider(provider) ||
    provider.location.directory !== target.directory ||
    provider.data.id !== target.providerID ||
    (provider.data.canonical !== undefined &&
      provider.data.canonical !== target.providerID) ||
    (provider.data.integrationID ?? provider.data.id) !== target.integrationID ||
    provider.data.activation === "disabled" ||
    !validIntegration(integration) ||
    integration.location.directory !== target.directory ||
    integration.data.id !== target.integrationID ||
    !Array.isArray(credentials) ||
    credentials.length > 1000 ||
    !validCredentials(credentials)
  )
    throw new Error("OpenCode native payer evidence unavailable");
  const [active] = integration.data.connections;
  if (!active || active.status)
    throw new Error("OpenCode native payer unavailable");
  // Pinned Integration.connection.active uses the first connection, including
  // saved entries ahead of the environment. Do not use Credential.Entry.active.
  const source: PayerSource =
    active.type === "env"
      ? { kind: "api_key_env", name: active.name }
      : { kind: "native_credential", id: active.id, method: active.method };
  return Object.freeze({
    source: Object.freeze(source),
    connectionCount: integration.data.connections.length,
    storedCredentialCount: credentials.length,
  });
}

function captureOpenCodePayer(
  binding: OpenCodeSelectedPayerBinding,
  selection: Selection,
  model: Readonly<ModelRef>,
  environment: HarnessHost["environment"],
): OpenCodeSelectedPayerBinding {
  const reference = binding?.credentialReference;
  const source = binding?.source;
  if (
    selection.billingSource !== "api_key" ||
    source?.kind !== "api_key_env" ||
    !binding.scope ||
    scopeFields.some((field) => binding.scope[field] !== selection[field]) ||
    !binding.providerID ||
    !binding.integrationID ||
    !validModel(model) ||
    model.providerID !== binding.providerID ||
    (model.id !== selection.modelId &&
      `${model.providerID}/${model.id}` !== selection.modelId) ||
    !RuntimeCredentialReferenceSchema.safeParse(reference).success ||
    reference.connectionId !== selection.connectionId ||
    reference.providerId !== binding.providerID ||
    reference.ownerGeneration !== selection.authOwnerGeneration ||
    typeof binding.assertCurrent !== "function" ||
    typeof binding.assertEffectivePayer !== "function" ||
    !/^[A-Z][A-Z0-9_]*$/.test(source.name) ||
    !/^[a-f0-9]{64}$/.test(binding.fingerprint) ||
    (binding.expiresAt !== null && !Number.isSafeInteger(binding.expiresAt))
  )
    throw new Error("OpenCode selected API-key binding unavailable");
  const key = Object.hasOwn(environment, source.name)
    ? environment[source.name]
    : undefined;
  if (
    !key ||
    key.length > 65_536 ||
    /[\s\0{}[\]"]/u.test(key) ||
    createHash("sha256").update(key).digest("hex") !== binding.fingerprint
  )
    throw new Error("OpenCode selected API-key material unavailable");
  return Object.freeze({
    ...binding,
    scope: Object.freeze({ ...binding.scope }),
    credentialReference: Object.freeze({ ...reference }),
    source: Object.freeze({ ...source }),
  });
}

/** Binds payer checks to one admitted process and its frozen native model. */
export class OpenCodePayerGuard {
  private readonly binding: OpenCodeSelectedPayerBinding;
  private readonly target: OpenCodePayerTarget;
  private readonly processGeneration: string;

  constructor(
    binding: OpenCodeSelectedPayerBinding,
    private readonly command: HarnessStartCommand,
    private readonly host: HarnessHost,
    private readonly model: Readonly<ModelRef>,
    private readonly agent: string | undefined,
    private readonly openingSignal: AbortSignal,
  ) {
    this.binding = captureOpenCodePayer(
      binding,
      command.selection,
      model,
      host.environment,
    );
    this.target = Object.freeze({
      providerID: this.binding.providerID,
      integrationID: this.binding.integrationID,
      directory: host.workspaceRoot,
    });
    this.processGeneration = host.processGeneration;
  }

  async authorize(
    signal: AbortSignal,
    externalSessionId: string | null,
    transport?: Pick<OpenCodeClient, "inspectPayer">,
  ): Promise<() => void> {
    const { binding, command, host, model, agent } = this;
    await binding.assertEffectivePayer(
      Object.freeze({
        command,
        host,
        model,
        agent,
        binding,
        externalSessionId,
        signal,
      }),
    );
    if (transport) {
      const inspection = await transport.inspectPayer(this.target, signal);
      if (
        binding.source.kind !== "api_key_env" ||
        inspection.source.kind !== "api_key_env" ||
        inspection.source.name !== binding.source.name ||
        inspection.connectionCount !== 1 ||
        inspection.storedCredentialCount !== 0
      )
        throw new Error(
          "OpenCode native payer differs from selected connection",
        );
    }
    const lease = await binding.assertCurrent(
      Object.freeze({
        selection: command.selection,
        credentialReference: binding.credentialReference,
        providerID: binding.providerID,
        integrationID: binding.integrationID,
        source: binding.source,
        fingerprint: binding.fingerprint,
        expiresAt: binding.expiresAt,
        processGeneration: this.processGeneration,
        signal,
      }),
    );
    return () => {
      if (
        this.openingSignal.aborted ||
        signal.aborted ||
        (binding.expiresAt !== null && Date.now() >= binding.expiresAt) ||
        lease.canDeliver() !== true
      )
        throw new Error("OpenCode selected payer lease fenced");
    };
  }
}

/** A transport password is independent of the selected provider credential. Never serialize it. */
export function createOpenCodeServerPassword(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Input is the selected credential/config overlay, never process.env. Pass the result
 * to createHarnessHost.selectedEnvironment; the host separately preserves actual HOME
 * and its system allowlist. Vault materialization, user identity and OS enforcement stay host-owned.
 * In stdio launch mode OpenCode removes its password before starting tools.
 */
export function openCodeServerEnvironment(
  isolated: Readonly<Record<string, string>>,
  password: string,
): Readonly<Record<string, string>> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(password))
    throw new Error("Invalid OpenCode transport credential.");
  const environment = { ...isolated };
  delete environment.OPENCODE_SERVER_PASSWORD;
  delete environment.OPENCODE_PASSWORD;
  delete environment.OPENCODE_PTY_HANDOFF;
  return Object.freeze({
    ...environment,
    OPENCODE_PASSWORD: password,
    OPENCODE_CLIENT: "legioncode",
    OPENCODE_DB: "opencode.db",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
  });
}
