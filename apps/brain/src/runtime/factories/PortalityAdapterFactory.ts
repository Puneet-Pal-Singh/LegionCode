/**
 * PortalityAdapterFactory - Compose runtime ports and adapters.
 *
 * Single Responsibility: Wire port interfaces to adapter implementations.
 * Decouples Brain orchestration logic from infrastructure-specific implementation details.
 */

import type { Env } from "../../types/ai";
import { CloudflareExecutionAdapter } from "../adapters/CloudflareExecutionAdapter";
import { CloudflareProviderAdapter } from "../adapters/CloudflareProviderAdapter";
import { CloudflareEventStreamAdapter } from "../adapters/CloudflareEventStreamAdapter";
import { CloudflareLifecycleEventStreamAdapter } from "../adapters/CloudflareLifecycleEventStreamAdapter";
import type {
  ExecutionRuntimePort,
  LifecycleEventStreamPort,
  ProviderResolutionPort,
  RealtimeEventPort,
} from "../ports";
import type { AIService } from "../../services/AIService";
import type { ProviderConfigService } from "../../services/providers";

/**
 * Create a Cloudflare-backed execution runtime port.
 *
 * @param ctx - Durable Object context (owns run/task state)
 * @returns ExecutionRuntimePort implementation
 */
export function createCloudflareExecutionPort(
  ctx: unknown,
): ExecutionRuntimePort {
  return new CloudflareExecutionAdapter(ctx);
}

/**
 * Create a Cloudflare-backed provider resolution port.
 *
 * @param env - Cloudflare environment
 * @param aiService - AI service (model/provider router)
 * @param providerConfigService - Provider configuration service
 * @returns ProviderResolutionPort implementation
 */
export function createCloudflareProviderPort(
  _env: Env,
  _aiService: AIService,
  _providerConfigService: ProviderConfigService,
): ProviderResolutionPort {
  return new CloudflareProviderAdapter();
}

/**
 * Create a Cloudflare-backed realtime event port.
 *
 * @returns RealtimeEventPort implementation
 */
export function createCloudflareEventStreamPort(): RealtimeEventPort {
  return new CloudflareEventStreamAdapter();
}

export function createCloudflareLifecycleEventStreamPort(): LifecycleEventStreamPort {
  return new CloudflareLifecycleEventStreamAdapter();
}

/**
 * Composite factory for all runtime ports.
 * Returns a complete set of adapter implementations.
 */
export interface RuntimePorts {
  executionRuntime: ExecutionRuntimePort;
  providerResolution: ProviderResolutionPort;
  eventStream: RealtimeEventPort;
  lifecycleEventStream: LifecycleEventStreamPort;
}

/**
 * Create a complete set of runtime ports for Brain orchestration.
 * Default implementation uses Cloudflare infrastructure.
 *
 * @param ctx - Durable Object context
 * @param env - Cloudflare environment
 * @param aiService - AI service
 * @param providerConfigService - Provider configuration service
 * @returns Complete set of runtime ports
 */
export function createRuntimePorts(
  ctx: unknown,
  env: Env,
  aiService: AIService,
  providerConfigService: ProviderConfigService,
): RuntimePorts {
  return {
    executionRuntime: createCloudflareExecutionPort(ctx),
    providerResolution: createCloudflareProviderPort(
      env,
      aiService,
      providerConfigService,
    ),
    eventStream: createCloudflareEventStreamPort(),
    lifecycleEventStream: createCloudflareLifecycleEventStreamPort(),
  };
}
