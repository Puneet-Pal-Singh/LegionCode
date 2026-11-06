import type { DurableObjectState } from "@cloudflare/workers-types";
import { ProviderError } from "../../domain/errors";
import type { Env } from "../../types/ai";
import type { ProviderRuntimeScopeInput } from "../../types/provider-scope";
import {
  normalizeProviderScope,
  sanitizeScopeSegment,
} from "./provider-scope";

type ByokRateLimitAction = "connect" | "validate";

interface RateLimitWindowRecord {
  windowStartedAt: number;
  count: number;
}

interface RateLimitRule {
  maxRequests: number;
  windowMs: number;
}

interface ByokRateLimitConfig {
  connect: RateLimitRule;
  validate: RateLimitRule;
}

const RATE_LIMIT_KEY_PREFIX = "provider:rate-limit:v1:";

export class ProviderRateLimitService {
  private readonly scope;
  private readonly config: ByokRateLimitConfig;

  constructor(
    private readonly state: DurableObjectState,
    scopeInput: ProviderRuntimeScopeInput,
    config: ByokRateLimitConfig,
  ) {
    this.scope = normalizeProviderScope(scopeInput);
    this.config = config;
  }

  static fromEnv(
    state: DurableObjectState,
    scopeInput: ProviderRuntimeScopeInput,
    env: Env,
  ): ProviderRateLimitService {
    return new ProviderRateLimitService(
      state,
      scopeInput,
      readByokRateLimitConfig(env),
    );
  }

  async enforce(action: ByokRateLimitAction): Promise<void> {
    const rule = action === "connect" ? this.config.connect : this.config.validate;
    const key = this.getRateLimitKey(action);
    const now = Date.now();
    const current = await this.readWindowRecord(key);

    // Check limit BEFORE incrementing to ensure exactly maxRequests per window
    if (current && current.count >= rule.maxRequests && now - current.windowStartedAt < rule.windowMs) {
      const retryAfterSeconds = calculateRetryAfterSeconds(current, now, rule.windowMs);
      throw new ProviderError(
        `BYOK ${action} rate limit exceeded. Retry in ${retryAfterSeconds}s.`,
        "RATE_LIMITED",
        429,
        true,
      );
    }

    const next = computeNextWindowState(current, now, rule.windowMs);
    await this.state.storage?.put(key, JSON.stringify(next));
  }

  private async readWindowRecord(key: string): Promise<RateLimitWindowRecord | null> {
    const raw = await this.state.storage?.get(key);
    if (typeof raw !== "string") {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as RateLimitWindowRecord;
      if (
        typeof parsed.count !== "number" ||
        typeof parsed.windowStartedAt !== "number"
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private getRateLimitKey(action: ByokRateLimitAction): string {
    const user = sanitizeScopeSegment(this.scope.userId);
    const workspace = sanitizeScopeSegment(this.scope.workspaceId);
    return `${RATE_LIMIT_KEY_PREFIX}${user}:${workspace}:${action}`;
  }
}

function readByokRateLimitConfig(env: Env): ByokRateLimitConfig {
  return {
    connect: {
      maxRequests: parseIntegerWithDefault(env.BYOK_CONNECT_RATE_LIMIT_MAX, 10),
      windowMs:
        parseIntegerWithDefault(env.BYOK_CONNECT_RATE_LIMIT_WINDOW_SECONDS, 60) *
        1000,
    },
    validate: {
      maxRequests: parseIntegerWithDefault(env.BYOK_VALIDATE_RATE_LIMIT_MAX, 30),
      windowMs:
        parseIntegerWithDefault(env.BYOK_VALIDATE_RATE_LIMIT_WINDOW_SECONDS, 60) *
        1000,
    },
  };
}

function parseIntegerWithDefault(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function computeNextWindowState(
  current: RateLimitWindowRecord | null,
  now: number,
  windowMs: number,
): RateLimitWindowRecord {
  if (!current || now - current.windowStartedAt >= windowMs) {
    return {
      count: 1,
      windowStartedAt: now,
    };
  }
  return {
    count: current.count + 1,
    windowStartedAt: current.windowStartedAt,
  };
}

function calculateRetryAfterSeconds(
  current: RateLimitWindowRecord,
  now: number,
  windowMs: number,
): number {
  const elapsed = now - current.windowStartedAt;
  const remainingMs = Math.max(windowMs - elapsed, 1000);
  return Math.ceil(remainingMs / 1000);
}
