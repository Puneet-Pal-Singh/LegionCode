import type { DelegatedHarnessPort } from "@repo/runtime-kernel";
import {
  createHarnessHost,
  HarnessExecutionPort,
  HarnessRegistry,
  HarnessSessionManager,
  type HarnessInstanceScope,
  type HarnessRecoveryInput,
  type HarnessLaunchPolicy,
  type SupervisedProcess,
} from "@repo/harness-core/server";
import type { CodexDriver } from "@repo/harness-codex/server";
import type { ClaudeDriver } from "@repo/harness-claude/server";
import type { OpenCodeV2Driver } from "@repo/harness-opencode/server";
import type { HarnessStartCommand } from "@repo/worker-protocol";
import {
  isCloudHarnessCleanup,
  type CloudHarnessTarget,
  type CloudHarnessActiveTarget,
  type CloudHarnessCleanupTarget,
} from "../src/harness/CloudHarnessBridgeProtocol";
import {
  assertCloudHarnessLaunchAvailable,
  CLOUD_HARNESS_AVAILABILITY,
  CloudHarnessUnavailableError,
} from "../src/harness/CloudHarnessAvailability";

type HostConfiguration = Omit<
  Parameters<typeof createHarnessHost>[0],
  "workspaceRoot" | "launchPolicy"
>;

type CodexDriverOptions = NonNullable<
  ConstructorParameters<typeof CodexDriver>[1]
>;
/** Trusted selected-connection setup supplies these before registration. Never
 * derive the fingerprint by blessing the first account observed at runtime.
 */
export type CloudCodexInstanceOptions = Omit<
  CodexDriverOptions,
  "policy" | "accountBinding"
> & {
  readonly policy: NonNullable<CodexDriverOptions["policy"]>;
  readonly accountBinding: NonNullable<CodexDriverOptions["accountBinding"]>;
};

/** Native policy resolution/attestation and physical quiescence are required
 * authority callbacks. They do not replace the independent OS launch policy.
 */
export type CloudOpenCodeInstanceOptions = ConstructorParameters<
  typeof OpenCodeV2Driver
>[0];

/** Concrete current-backend policy. There is no unrestricted/UID fallback. */
export class SandboxHarnessLaunchPolicy implements HarnessLaunchPolicy {
  async assertEnforced(): Promise<void> {
    assertCloudHarnessLaunchAvailable();
  }
  async launch(): Promise<SupervisedProcess> {
    throw new CloudHarnessUnavailableError();
  }
}

/** Trusted Node composition only. Workers/renderers cannot supply native drivers,
 * executable paths, credentials, or a replacement launch policy.
 */
export class CloudHarnessComposition {
  private readonly registry = new HarnessRegistry();
  private readonly hostExecution = new HarnessExecutionPort(
    new HarnessSessionManager(this.registry),
  );
  readonly execution: DelegatedHarnessPort = this.hostExecution;
  readonly launchPolicy = new SandboxHarnessLaunchPolicy();
  constructor(
    private readonly authority: {
      assertActive(target: CloudHarnessActiveTarget): Promise<void>;
      /** Cleanup is authorized by durable lease/process ownership, not provider reauthentication. */
      assertCleanup(target: CloudHarnessCleanupTarget): Promise<void>;
      /** Resolve selected credentials only AFTER the enforcing capability gate. */
      configureHost(command: HarnessStartCommand): Promise<HostConfiguration>;
      /** Canonical failed/interrupted settlement plus durable replay. No physical-
       * quiescence-only acknowledgement and no fabricated missing observations.
       */
      resolveObservationIntegrity: NonNullable<
        HarnessRecoveryInput["resolveObservationIntegrity"]
      >;
    },
  ) {
    if (typeof authority.resolveObservationIntegrity !== "function")
      throw new Error(
        "Canonical observation integrity settlement authority is required",
      );
  }

  /** Trusted recovery setup, before any open/rebind. Core checks sticky journal
   * integrity and canonical failure replay before retiring the old stream.
   * A caller cannot replace the configured settlement authority in input.
   */
  reconcilePriorGeneration(
    input: Omit<HarnessRecoveryInput, "resolveObservationIntegrity">,
  ) {
    return this.hostExecution.reconcilePriorGeneration({
      ...input,
      resolveObservationIntegrity: (request) =>
        this.authority.resolveObservationIntegrity(request),
    });
  }

  status() {
    return CLOUD_HARNESS_AVAILABILITY;
  }
  authorize(target: CloudHarnessTarget): Promise<void> {
    return isCloudHarnessCleanup(target)
      ? this.authority.assertCleanup(target)
      : this.authority.assertActive(target);
  }
  async registerCodex(
    scope: HarnessInstanceScope & { readonly harness: "codex" },
    executable: string,
    options: CloudCodexInstanceOptions,
  ): Promise<void> {
    if (!options.policy || !options.accountBinding)
      throw new Error("Codex admitted policy/account binding is required");
    const admittedScope = Object.freeze({ ...scope });
    const configured = Object.freeze({
      ...options,
      policy: Object.freeze({ ...options.policy }),
      accountBinding: Object.freeze({ ...options.accountBinding }),
    });
    if (
      configured.accountBinding.instanceId !== admittedScope.instanceId ||
      configured.accountBinding.connectionId !== admittedScope.connectionId ||
      configured.accountBinding.authOwnerGeneration !==
        admittedScope.authOwnerGeneration ||
      !/^[a-f0-9]{64}$/.test(configured.accountBinding.identityFingerprint)
    ) {
      throw new Error(
        "Codex selected account binding does not match the configured instance",
      );
    }
    const { CodexDriver } = await import("@repo/harness-codex/server");
    this.register(admittedScope, new CodexDriver(executable, configured));
  }
  async registerClaude(
    scope: HarnessInstanceScope & { readonly harness: "claude" },
  ): Promise<void> {
    const { ClaudeDriver } = await import("@repo/harness-claude/server");
    this.register(scope, new ClaudeDriver());
  }
  async registerOpenCode(
    scope: HarnessInstanceScope & { readonly harness: "opencode" },
    options: CloudOpenCodeInstanceOptions,
  ): Promise<void> {
    const admittedScope = Object.freeze({ ...scope });
    const configured = Object.freeze({ ...options });
    if (
      typeof configured.resolvePolicy !== "function" ||
      typeof configured.assertEffectivePolicy !== "function"
    )
      throw new Error("OpenCode native policy authority is required");
    const { OpenCodeV2Driver } = await import("@repo/harness-opencode/server");
    this.register(admittedScope, new OpenCodeV2Driver(configured));
  }
  private register(
    scope: HarnessInstanceScope,
    driver: CodexDriver | ClaudeDriver | OpenCodeV2Driver,
  ): void {
    this.registry.register({
      scope,
      driver,
      createHost: async (command) => {
        await this.authority.assertActive({ operation: "open", command });
        // OpenCode boot can auto-resume claims. Gate even open, BEFORE resolving
        // credentials/configuration or touching any provider-owned state.
        assertCloudHarnessLaunchAvailable();
        const configuration = await this.authority.configureHost(command);
        await this.authority.assertActive({ operation: "open", command });
        return createHarnessHost({
          ...configuration,
          workspaceRoot: command.filesystemRoot,
          launchPolicy: this.launchPolicy,
        });
      },
    });
  }
}
