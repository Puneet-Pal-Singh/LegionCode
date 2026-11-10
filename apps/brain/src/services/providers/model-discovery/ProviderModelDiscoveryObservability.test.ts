import { describe, expect, it } from "vitest";
import { ProviderModelDiscoveryObservability } from "@repo/provider-core/discovery";

describe("ProviderModelDiscoveryObservability", () => {
  it("records latency, cache hits, stale requests, and adapter failures", () => {
    const observability = new ProviderModelDiscoveryObservability(false);
    observability.recordRequest({
      providerId: "openrouter",
      source: "provider_api",
      stale: false,
      success: true,
      latencyMs: 120,
    });
    observability.recordRequest({
      providerId: "openrouter",
      source: "cache",
      stale: true,
      success: true,
      latencyMs: 80,
    });
    observability.recordCacheHit("openrouter");
    observability.recordAdapterFailure(
      "openrouter",
      "MODEL_DISCOVERY_PROVIDER_API_FAILED",
    );

    const metrics = observability.getMetrics();
    expect(metrics.model_discovery_requests_total.openrouter_provider_api_success).toBe(
      1,
    );
    expect(metrics.model_discovery_requests_total.openrouter_cache_success).toBe(1);
    expect(metrics.model_discovery_fetch_latency_ms).toEqual([120, 80]);
    expect(metrics.model_discovery_cache_hits_total.openrouter).toBe(1);
    expect(metrics.model_discovery_stale_total.openrouter).toBe(1);
    expect(
      metrics.model_discovery_adapter_failures_total.openrouter_MODEL_DISCOVERY_PROVIDER_API_FAILED,
    ).toBe(1);
  });

  it("raises alerts for repeated failures and stale ratio", () => {
    const observability = new ProviderModelDiscoveryObservability(false);
    observability.recordRequest({
      providerId: "google",
      source: "cache",
      stale: true,
      success: true,
      latencyMs: 2500,
    });
    observability.recordRequest({
      providerId: "google",
      source: "cache",
      stale: true,
      success: true,
      latencyMs: 2600,
    });
    observability.recordAdapterFailure(
      "google",
      "MODEL_DISCOVERY_PROVIDER_API_FAILED",
    );
    observability.recordAdapterFailure(
      "google",
      "MODEL_DISCOVERY_PROVIDER_API_FAILED",
    );
    observability.recordAdapterFailure("google", "MODEL_DISCOVERY_AUTH_FAILED");

    const alerts = observability.getAlerts();
    expect(alerts.some((alert) => alert.message.includes("adapter failures"))).toBe(
      true,
    );
    expect(alerts.some((alert) => alert.message.includes("stale ratio"))).toBe(
      true,
    );
    expect(alerts.some((alert) => alert.message.includes("latency"))).toBe(true);
  });
});
