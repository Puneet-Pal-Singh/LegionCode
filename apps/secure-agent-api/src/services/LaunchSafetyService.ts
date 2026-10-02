import { errorResponse } from "../schemas/http-api";

const DEFAULT_SESSION_CREATE_AUTH_LIMIT = 20;
const DEFAULT_SESSION_CREATE_ANON_LIMIT = 10;
const DEFAULT_SESSION_CREATE_WINDOW_SECONDS = 600;
const DEFAULT_EXECUTE_AUTH_LIMIT = 120;
const DEFAULT_EXECUTE_ANON_LIMIT = 20;
const DEFAULT_EXECUTE_WINDOW_SECONDS = 600;

type RouteClass = "session_create" | "execute_task";

interface LaunchRateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface LaunchSafetyEnv {
  LAUNCH_RATE_LIMITER?: DurableObjectNamespace;
  LAUNCH_EMERGENCY_SHUTOFF_MODE?: string;
  LAUNCH_RATE_LIMIT_REQUIRED?: "true" | "false";
  SESSION_CREATE_RATE_LIMIT_AUTH_MAX?: string;
  SESSION_CREATE_RATE_LIMIT_ANON_MAX?: string;
  SESSION_CREATE_RATE_LIMIT_WINDOW_SECONDS?: string;
  EXECUTE_TASK_RATE_LIMIT_AUTH_MAX?: string;
  EXECUTE_TASK_RATE_LIMIT_ANON_MAX?: string;
  EXECUTE_TASK_RATE_LIMIT_WINDOW_SECONDS?: string;
}

interface RouteLimitRule {
  limit: number;
  windowSeconds: number;
}

export async function enforceLaunchSafetyForRoute(
  request: Request,
  env: LaunchSafetyEnv,
  routeClass: RouteClass,
): Promise<Response | null> {
  if (isEmergencyModeActive(env)) {
    return errorResponse(
      "LegionCode runtime is temporarily in maintenance mode. Please retry shortly.",
      "EMERGENCY_SHUTOFF_ACTIVE",
      503,
    );
  }

  if (isInternalServiceBindingRequest(request)) {
    return null;
  }

  const limiterNamespace = env.LAUNCH_RATE_LIMITER;
  if (!limiterNamespace) {
    if (env.LAUNCH_RATE_LIMIT_REQUIRED === "true") {
      return errorResponse(
        "Launch safety limiter is unavailable. Please retry shortly.",
        "LAUNCH_RATE_LIMITER_UNAVAILABLE",
        503,
      );
    }
    return null;
  }

  const hasAuthorization = hasAuthorizationHeader(request);
  const limitRule = resolveRouteRule(env, routeClass, hasAuthorization);
  const scopeId = buildScopeId(request, routeClass, hasAuthorization);
  const id = limiterNamespace.idFromName(scopeId);
  const stub = limiterNamespace.get(id);

  const decision = await requestLimiterDecision(stub, {
    routeClass,
    limit: limitRule.limit,
    windowSeconds: limitRule.windowSeconds,
  });
  if (decision === null) {
    return errorResponse(
      "Launch safety limiter request failed.",
      "LAUNCH_RATE_LIMITER_FAILED",
      503,
    );
  }

  if (!isRateLimitDecision(decision)) {
    return errorResponse(
      "Launch safety limiter returned an invalid response.",
      "LAUNCH_RATE_LIMITER_INVALID_RESPONSE",
      503,
    );
  }

  if (!decision.allowed) {
    return errorResponse(
      `Rate limit exceeded. Retry in ${decision.retryAfterSeconds}s.`,
      "ROUTE_RATE_LIMITED",
      429,
      {
        routeClass,
        retryAfterSeconds: decision.retryAfterSeconds,
      },
    );
  }

  return null;
}

export function isEmergencyModeActive(env: LaunchSafetyEnv): boolean {
  const mode = getEmergencyShutoffMode(env);
  return mode === "block_all" || mode === "block_session_and_execute";
}

export function getEmergencyShutoffMode(
  env: LaunchSafetyEnv,
): "off" | "block_session_and_execute" | "block_all" {
  const mode = env.LAUNCH_EMERGENCY_SHUTOFF_MODE?.trim().toLowerCase();
  if (mode === "block_all" || mode === "block_session_and_execute") {
    return mode;
  }
  return "off";
}

function hasAuthorizationHeader(request: Request): boolean {
  const auth = request.headers.get("Authorization")?.trim() ?? "";
  return auth.length > 0;
}

function resolveRouteRule(
  env: LaunchSafetyEnv,
  routeClass: RouteClass,
  hasAuthorization: boolean,
): RouteLimitRule {
  if (routeClass === "session_create") {
    return {
      limit: hasAuthorization
        ? readPositiveInt(
            env.SESSION_CREATE_RATE_LIMIT_AUTH_MAX,
            DEFAULT_SESSION_CREATE_AUTH_LIMIT,
          )
        : readPositiveInt(
            env.SESSION_CREATE_RATE_LIMIT_ANON_MAX,
            DEFAULT_SESSION_CREATE_ANON_LIMIT,
          ),
      windowSeconds: readPositiveInt(
        env.SESSION_CREATE_RATE_LIMIT_WINDOW_SECONDS,
        DEFAULT_SESSION_CREATE_WINDOW_SECONDS,
      ),
    };
  }

  return {
    limit: hasAuthorization
      ? readPositiveInt(
          env.EXECUTE_TASK_RATE_LIMIT_AUTH_MAX,
          DEFAULT_EXECUTE_AUTH_LIMIT,
        )
      : readPositiveInt(
          env.EXECUTE_TASK_RATE_LIMIT_ANON_MAX,
          DEFAULT_EXECUTE_ANON_LIMIT,
        ),
    windowSeconds: readPositiveInt(
      env.EXECUTE_TASK_RATE_LIMIT_WINDOW_SECONDS,
      DEFAULT_EXECUTE_WINDOW_SECONDS,
    ),
  };
}

function buildScopeId(
  request: Request,
  routeClass: RouteClass,
  hasAuthorization: boolean,
): string {
  const ip = resolveClientIp(request);
  const authClass = hasAuthorization ? "signed" : "anon";
  return `${routeClass}:${authClass}:ip:${ip}`;
}

function resolveClientIp(request: Request): string {
  const cfIp = request.headers.get("CF-Connecting-IP")?.trim() ?? "";
  if (cfIp.length > 0) {
    return cfIp;
  }

  const forwarded = request.headers.get("X-Forwarded-For")?.trim() ?? "";
  const firstForwarded = forwarded.split(",")[0]?.trim() ?? "";
  if (firstForwarded.length > 0) {
    return firstForwarded;
  }

  return "unknown-ip";
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function isRateLimitDecision(value: unknown): value is LaunchRateLimitDecision {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.allowed === "boolean" &&
    typeof candidate.retryAfterSeconds === "number" &&
    Number.isFinite(candidate.retryAfterSeconds) &&
    candidate.retryAfterSeconds >= 0
  );
}

function isInternalServiceBindingRequest(request: Request): boolean {
  try {
    const url = new URL(request.url);
    return url.hostname === "internal";
  } catch (error) {
    console.warn("[launch-safety/internal-request] failed to parse request URL", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function requestLimiterDecision(
  limiter: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> },
  payload: {
    routeClass: RouteClass;
    limit: number;
    windowSeconds: number;
  },
): Promise<unknown | null> {
  try {
    const limiterResponse = await limiter.fetch(
      "https://secure-api-launch-limiter/enforce",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );

    if (!limiterResponse.ok) {
      return null;
    }

    return (await limiterResponse.json()) as unknown;
  } catch {
    return null;
  }
}
