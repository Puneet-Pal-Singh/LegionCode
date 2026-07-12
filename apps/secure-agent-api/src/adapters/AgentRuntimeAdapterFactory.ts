/**
 * AgentRuntimeAdapterFactory - Composition factory for secure-agent-api adapters.
 *
 * Wires Cloudflare-specific implementations to canonical port interfaces.
 * Ensures AgentRuntime depends on ports, not platform details.
 *
 * Aligned to Plan 59 (Decompose/Decouple) and PORTABILITY-BOUNDARY-DECOUPLING-PLAN.
 */

import type { DurableObjectState } from "@cloudflare/workers-types";
import { Sandbox } from "@cloudflare/sandbox";
import {
  SandboxExecutionPort,
  SessionStatePort,
  ArtifactStorePort,
} from "../ports";
import { CloudflareSandboxExecutionAdapter } from "./CloudflareSandboxExecutionAdapter";
import { CloudflareSessionStateAdapter } from "./CloudflareSessionStateAdapter";
import { CloudflareArtifactStoreAdapter } from "./CloudflareArtifactStoreAdapter";
import { IPlugin } from "../interfaces/types";
import type { SandboxExecutionLease } from "../ports/SandboxExecutionLease";

export type RuntimeExecutionBackend =
  | "cloudflare_sandbox"
  | "e2b"
  | "daytona";

export class UnsupportedExecutionBackendError extends Error {
  constructor(backend: RuntimeExecutionBackend) {
    super(
      `[runtime/composition] Unsupported execution backend '${backend}'. Only 'cloudflare_sandbox' is implemented in this phase.`,
    );
    this.name = "UnsupportedExecutionBackendError";
  }
}

/**
 * R2 bucket interface type for artifact storage.
 */
interface R2Bucket {
  head(key: string): Promise<any>;
  get(key: string): Promise<any>;
  put(key: string, value: any): Promise<any>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: { prefix?: string }): Promise<any>;
}

/**
 * Composition configuration for adapters.
 */
interface AdapterCompositionConfig {
  durableObjectState: DurableObjectState;
  sandbox: Sandbox;
  plugins: Map<string, IPlugin>;
  r2Bucket: R2Bucket;
  executionBackend?: RuntimeExecutionBackend;
  executionLease?: SandboxExecutionLease;
}

/**
 * Factory for composing Cloudflare adapters into canonical port interfaces.
 *
 * Single responsibility: Create and wire adapter instances.
 * No business logic, only composition.
 */
export class AgentRuntimeAdapterFactory {
  /**
   * Create sandbox execution adapter.
   *
   * Maps Cloudflare sandbox + plugins to SandboxExecutionPort.
   */
  static createSandboxExecutionAdapter(
    sandbox: Sandbox,
    plugins: Map<string, IPlugin>,
    executionBackend: RuntimeExecutionBackend = "cloudflare_sandbox",
    executionLease?: SandboxExecutionLease,
  ): SandboxExecutionPort {
    if (executionBackend === "cloudflare_sandbox") {
      return new CloudflareSandboxExecutionAdapter(sandbox, plugins, executionLease);
    }
    throw new UnsupportedExecutionBackendError(executionBackend);
  }

  /**
   * Create session state adapter.
   *
   * Maps Durable Object storage to SessionStatePort.
   */
  static createSessionStateAdapter(
    durableObjectState: DurableObjectState,
  ): SessionStatePort {
    return new CloudflareSessionStateAdapter(durableObjectState);
  }

  /**
   * Create artifact store adapter.
   *
   * Maps R2 object storage to ArtifactStorePort.
   */
  static createArtifactStoreAdapter(r2Bucket: R2Bucket): ArtifactStorePort {
    return new CloudflareArtifactStoreAdapter(r2Bucket);
  }

  /**
   * Create all adapters from configuration.
   *
   * Convenience method for full composition in AgentRuntime.
   * Returns object with all three ports wired.
   */
  static createAdapters(config: AdapterCompositionConfig): {
    sandboxExecution: SandboxExecutionPort;
    sessionState: SessionStatePort;
    artifactStore: ArtifactStorePort;
  } {
    const executionBackend = config.executionBackend ?? "cloudflare_sandbox";

    return {
      sandboxExecution: this.createSandboxExecutionAdapter(
        config.sandbox,
        config.plugins,
        executionBackend,
        config.executionLease,
      ),
      sessionState: this.createSessionStateAdapter(
        config.durableObjectState,
      ),
      artifactStore: this.createArtifactStoreAdapter(config.r2Bucket),
    };
  }
}
