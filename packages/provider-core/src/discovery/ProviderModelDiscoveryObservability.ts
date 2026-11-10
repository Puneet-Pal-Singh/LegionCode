import type { BYOKModelDiscoverySource } from "@repo/shared-types";

export interface ProviderModelDiscoveryMetrics {
  model_discovery_requests_total: Record<string, number>;
  model_discovery_fetch_latency_ms: number[];
  model_discovery_cache_hits_total: Record<string, number>;
  model_discovery_stale_total: Record<string, number>;
  model_discovery_adapter_failures_total: Record<string, number>;
  openrouter_recommendation_metrics: Record<
    string,
    OpenRouterRecommendationMetric
  >;
}

export interface ProviderModelDiscoveryRequestMetric {
  providerId: string;
  source: BYOKModelDiscoverySource;
  stale: boolean;
  success: boolean;
  latencyMs: number;
}

export interface OpenRouterRecommendationMetric {
  userInventoryCount: number;
  programmingInventoryCount: number;
  intersectionCount: number;
  recommendationCount: number;
  autoInjected: boolean;
}

export class ProviderModelDiscoveryObservability {
  private static readonly MAX_LATENCY_SAMPLES = 10_000;
  private metrics: ProviderModelDiscoveryMetrics;

  constructor(private readonly enableLogging = false) {
    this.metrics = this.createEmptyMetrics();
  }

  recordRequest(metric: ProviderModelDiscoveryRequestMetric): void {
    const key = [
      metric.providerId,
      metric.source,
      metric.success ? "success" : "failure",
    ].join("_");
    this.metrics.model_discovery_requests_total[key] =
      (this.metrics.model_discovery_requests_total[key] ?? 0) + 1;
    this.pushLatencySample(metric.latencyMs);
    if (metric.stale) {
      this.metrics.model_discovery_stale_total[metric.providerId] =
        (this.metrics.model_discovery_stale_total[metric.providerId] ?? 0) + 1;
    }
    if (this.enableLogging) {
      console.log(
        `[provider-discovery/metrics] provider=${metric.providerId} source=${metric.source} stale=${metric.stale} status=${metric.success ? "success" : "failure"} latencyMs=${metric.latencyMs}`,
      );
    }
  }

  recordCacheHit(providerId: string): void {
    this.metrics.model_discovery_cache_hits_total[providerId] =
      (this.metrics.model_discovery_cache_hits_total[providerId] ?? 0) + 1;
  }

  recordAdapterFailure(providerId: string, code: string): void {
    const key = `${providerId}_${code}`;
    this.metrics.model_discovery_adapter_failures_total[key] =
      (this.metrics.model_discovery_adapter_failures_total[key] ?? 0) + 1;
  }

  recordOpenRouterRecommendation(
    userInventoryCount: number,
    programmingInventoryCount: number,
    intersectionCount: number,
    finalRecommendationCount: number,
    autoInjected: boolean,
  ): void {
    this.metrics.openrouter_recommendation_metrics["latest"] = {
      userInventoryCount,
      programmingInventoryCount,
      intersectionCount,
      recommendationCount: finalRecommendationCount,
      autoInjected,
    };
    if (this.enableLogging) {
      console.log(
        `[provider-discovery/openrouter-recommendation] userInventory=${userInventoryCount} programming=${programmingInventoryCount} intersection=${intersectionCount} final=${finalRecommendationCount} auto=${autoInjected}`,
      );
    }
  }

  getMetrics(): ProviderModelDiscoveryMetrics {
    return {
      ...this.metrics,
      model_discovery_fetch_latency_ms: [
        ...this.metrics.model_discovery_fetch_latency_ms,
      ],
      model_discovery_requests_total: {
        ...this.metrics.model_discovery_requests_total,
      },
      model_discovery_cache_hits_total: {
        ...this.metrics.model_discovery_cache_hits_total,
      },
      model_discovery_stale_total: {
        ...this.metrics.model_discovery_stale_total,
      },
      model_discovery_adapter_failures_total: {
        ...this.metrics.model_discovery_adapter_failures_total,
      },
    };
  }

  getAlerts(): Array<{ severity: "warning" | "critical"; message: string }> {
    const stats = this.getStatistics();
    const alerts: Array<{ severity: "warning" | "critical"; message: string }> =
      [];
    if (stats.adapterFailureTotal >= 3) {
      alerts.push({
        severity: "critical",
        message: `Model discovery adapter failures elevated: ${stats.adapterFailureTotal}`,
      });
    }
    if (stats.staleRatio > 0.3) {
      alerts.push({
        severity: "warning",
        message: `Model discovery stale ratio high: ${(stats.staleRatio * 100).toFixed(1)}%`,
      });
    }
    if (stats.p95LatencyMs > 2000) {
      alerts.push({
        severity: "warning",
        message: `Model discovery latency high: p95=${stats.p95LatencyMs}ms`,
      });
    }
    return alerts;
  }

  reset(): void {
    this.metrics = this.createEmptyMetrics();
  }

  private getStatistics(): {
    staleRatio: number;
    p95LatencyMs: number;
    adapterFailureTotal: number;
  } {
    const totalRequests = Object.values(
      this.metrics.model_discovery_requests_total,
    ).reduce((sum, value) => sum + value, 0);
    const staleRequests = Object.values(
      this.metrics.model_discovery_stale_total,
    ).reduce((sum, value) => sum + value, 0);
    const staleRatio = totalRequests > 0 ? staleRequests / totalRequests : 0;
    const sortedLatency = [
      ...this.metrics.model_discovery_fetch_latency_ms,
    ].sort((first, second) => first - second);
    const p95Index = Math.max(
      0,
      Math.min(
        sortedLatency.length - 1,
        Math.ceil(sortedLatency.length * 0.95) - 1,
      ),
    );
    const p95LatencyMs = sortedLatency[p95Index] ?? 0;
    const adapterFailureTotal = Object.values(
      this.metrics.model_discovery_adapter_failures_total,
    ).reduce((sum, value) => sum + value, 0);
    return { staleRatio, p95LatencyMs, adapterFailureTotal };
  }

  private pushLatencySample(latencyMs: number): void {
    if (!Number.isFinite(latencyMs) || latencyMs < 0) {
      return;
    }
    this.metrics.model_discovery_fetch_latency_ms.push(latencyMs);
    if (
      this.metrics.model_discovery_fetch_latency_ms.length >
      ProviderModelDiscoveryObservability.MAX_LATENCY_SAMPLES
    ) {
      this.metrics.model_discovery_fetch_latency_ms =
        this.metrics.model_discovery_fetch_latency_ms.slice(
          -ProviderModelDiscoveryObservability.MAX_LATENCY_SAMPLES,
        );
    }
  }

  private createEmptyMetrics(): ProviderModelDiscoveryMetrics {
    return {
      model_discovery_requests_total: {},
      model_discovery_fetch_latency_ms: [],
      model_discovery_cache_hits_total: {},
      model_discovery_stale_total: {},
      model_discovery_adapter_failures_total: {},
      openrouter_recommendation_metrics: {},
    };
  }
}
