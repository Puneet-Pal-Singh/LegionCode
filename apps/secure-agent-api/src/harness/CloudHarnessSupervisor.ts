import type { Sandbox } from "@cloudflare/sandbox";
import type { HarnessStartCommand } from "@repo/worker-protocol";
import {
  assertCloudHarnessLaunchAvailable,
  CLOUD_HARNESS_AVAILABILITY,
} from "./CloudHarnessAvailability";
import {
  CloudHarnessBridgeTransport,
  type CloudHarnessBridgeOptions,
} from "./CloudHarnessBridgeTransport";

import type { CloudHarnessTarget } from "./CloudHarnessBridgeProtocol";
export type { CloudHarnessTarget } from "./CloudHarnessBridgeProtocol";

export interface CloudHarnessSupervisorAuthority {
  /** Existing durable admission, lease, credential-generation and workspace owners.
   * Must validate the immutable selection and learned process/session separately.
   */
  assertActive(target: CloudHarnessTarget): Promise<void>;
  sandbox(
    target: CloudHarnessTarget,
  ): Promise<Pick<Sandbox, "startProcess" | "getProcess" | "wsConnect">>;
  /** Private bridge token only, bound to this admission/lease/generation. */
  bridgeCredential(target: CloudHarnessTarget): Promise<string>;
}

/** Worker-safe sandbox bootstrap. Never imports a Node driver or executes provider commands. */
export class CloudHarnessSupervisor {
  // Lifetime cap 128, including failed/ambiguous starts. Never evict merely for
  // capacity: no canonical settlement/tombstone authority is provided here.
  private readonly statusBoots = new Map<string, Promise<void>>();
  constructor(private readonly authority: CloudHarnessSupervisorAuthority) {}

  status() {
    return CLOUD_HARNESS_AVAILABILITY;
  }

  /** Trusted packaged status server only. No credential material, instance state,
   * provider environment or external session is supplied to this process.
   */
  async bootstrapStatus(command: HarnessStartCommand): Promise<void> {
    const target = { command };
    await this.assertActive(target);
    const key = command.selection.runAttemptId;
    const prior = this.statusBoots.get(key);
    if (prior) return prior;
    if (this.statusBoots.size >= 128)
      throw new Error("Cloud harness bootstrap capacity reached");
    const boot = (async () => {
      const sandbox = await this.authority.sandbox(target);
      await this.assertActive(target);
      const processId = "legioncode-harness-status-v1";
      const existing = await sandbox.getProcess(processId);
      if (existing) {
        if ((await existing.getStatus()) !== "running")
          throw new Error("Cloud harness bootstrap requires recovery");
        await existing.waitForPort(4319, {
          path: "/healthz",
          status: 200,
          timeout: 10_000,
        });
      } else {
        // A lost start receipt stays ambiguous. The rejected promise is retained;
        // this supervisor never retries startProcess or boots provider state.
        const process = await sandbox.startProcess(
          "/usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin node /opt/legioncode/harness-host/main.mjs --status-only",
          { processId, autoCleanup: false },
        );
        await process.waitForPort(4319, {
          path: "/healthz",
          status: 200,
          timeout: 10_000,
        });
      }
      await this.assertActive(target);
    })().catch(() => {
      throw new Error(
        "Cloud harness status bootstrap failed; recovery required",
      );
    });
    this.statusBoots.set(key, boot);
    return boot;
  }

  async connect(
    target: CloudHarnessTarget,
    callbacks: Pick<
      CloudHarnessBridgeOptions,
      "signal" | "receive" | "disconnected"
    >,
  ): Promise<CloudHarnessBridgeTransport> {
    await this.assertActive(target);
    // Gate BEFORE bridge/provider credential resolution or any execution bootstrap.
    // The current backend has no reviewed enforcing launch policy.
    assertCloudHarnessLaunchAvailable();
    const sandbox = await this.authority.sandbox(target);
    const credential = await this.authority.bridgeCredential(target);
    return CloudHarnessBridgeTransport.connect(sandbox, {
      ...callbacks,
      credential,
      authorize: () => this.assertActive(target),
    });
  }

  async assertActive(target: CloudHarnessTarget): Promise<void> {
    try {
      await this.authority.assertActive(target);
    } catch {
      throw new Error("Cloud harness binding unavailable; recovery required");
    }
  }
}
