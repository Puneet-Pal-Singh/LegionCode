import {
  createHarnessHost,
  HarnessExecutionPort,
  HarnessRegistry,
  HarnessSessionManager,
  type HarnessInstanceScope,
  type HarnessLaunchPolicy,
  type SupervisedProcess,
} from "@repo/harness-core/server";
import type { CodexDriver } from "@repo/harness-codex/server";
import type { ClaudeDriver } from "@repo/harness-claude/server";
import type { OpenCodeV2Driver } from "@repo/harness-opencode/server";
import type { HarnessStartCommand } from "@repo/worker-protocol";
import type { CloudHarnessTarget } from "../src/harness/CloudHarnessBridgeProtocol";
import {
  assertCloudHarnessLaunchAvailable,
  CLOUD_HARNESS_AVAILABILITY,
  CloudHarnessUnavailableError,
} from "../src/harness/CloudHarnessAvailability";

type HostConfiguration = Omit<
  Parameters<typeof createHarnessHost>[0],
  "workspaceRoot" | "launchPolicy"
>;

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
  readonly execution = new HarnessExecutionPort(
    new HarnessSessionManager(this.registry),
  );
  readonly launchPolicy = new SandboxHarnessLaunchPolicy();
  constructor(
    private readonly authority: {
      assertActive(target: CloudHarnessTarget): Promise<void>;
      /** Resolve selected credentials only AFTER the enforcing capability gate. */
      configureHost(command: HarnessStartCommand): Promise<HostConfiguration>;
    },
  ) {}
  status() {
    return CLOUD_HARNESS_AVAILABILITY;
  }
  assertActive(target: CloudHarnessTarget): Promise<void> {
    return this.authority.assertActive(target);
  }
  async registerCodex(
    scope: HarnessInstanceScope & { readonly harness: "codex" },
    executable: string,
  ): Promise<void> {
    const { CodexDriver } = await import("@repo/harness-codex/server");
    this.register(scope, new CodexDriver(executable));
  }
  async registerClaude(
    scope: HarnessInstanceScope & { readonly harness: "claude" },
  ): Promise<void> {
    const { ClaudeDriver } = await import("@repo/harness-claude/server");
    this.register(scope, new ClaudeDriver());
  }
  async registerOpenCode(
    scope: HarnessInstanceScope & { readonly harness: "opencode" },
    options: ConstructorParameters<typeof OpenCodeV2Driver>[0],
  ): Promise<void> {
    const { OpenCodeV2Driver } = await import("@repo/harness-opencode/server");
    this.register(scope, new OpenCodeV2Driver(options));
  }
  private register(
    scope: HarnessInstanceScope,
    driver: CodexDriver | ClaudeDriver | OpenCodeV2Driver,
  ): void {
    this.registry.register({
      scope,
      driver,
      createHost: async (command) => {
        await this.authority.assertActive({ command });
        // OpenCode boot can auto-resume claims. Gate even open, BEFORE resolving
        // credentials/configuration or touching any provider-owned state.
        assertCloudHarnessLaunchAvailable();
        const configuration = await this.authority.configureHost(command);
        await this.authority.assertActive({ command });
        return createHarnessHost({
          ...configuration,
          workspaceRoot: command.filesystemRoot,
          launchPolicy: this.launchPolicy,
        });
      },
    });
  }
}
