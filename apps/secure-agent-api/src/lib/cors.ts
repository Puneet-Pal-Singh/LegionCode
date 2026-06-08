export interface CorsEnvConfig {
  CORS_ALLOWED_ORIGINS?: string;
  CORS_ALLOW_DEV_ORIGINS?: "true" | "false";
}

const BASE_CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Expose-Headers": [
    "X-Shadowbox-Runtime-Name",
    "X-Shadowbox-Runtime-Git-Sha",
    "X-Shadowbox-Runtime-Started-At",
    "X-Shadowbox-Runtime-Boot-Id",
    "X-Shadowbox-Runtime-Fingerprint",
  ].join(", "),
  "X-Content-Type-Options": "nosniff",
  Vary: "Origin",
} as const;

export function getCorsHeaders(
  request: Request,
  env?: CorsEnvConfig,
): Record<string, string> {
  const origin = request.headers.get("Origin");
  if (!origin) {
    return { ...BASE_CORS_HEADERS };
  }

  const allowedOrigin = resolveAllowedOrigin(origin, env);
  if (!allowedOrigin) {
    return { Vary: "Origin" };
  }

  return {
    ...BASE_CORS_HEADERS,
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Credentials": "true",
  };
}

export function handleCorsPreflight(
  request: Request,
  env?: CorsEnvConfig,
): Response | null {
  if (request.method !== "OPTIONS") {
    return null;
  }

  const origin = request.headers.get("Origin");
  if (origin && !resolveAllowedOrigin(origin, env)) {
    return new Response(null, { status: 204, headers: { Vary: "Origin" } });
  }

  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(request, env),
  });
}

function resolveAllowedOrigin(
  origin: string,
  env?: CorsEnvConfig,
): string | null {
  const normalized = normalizeOrigin(origin);
  if (!normalized) {
    return null;
  }

  const configuredOrigins = parseAllowedOrigins(env?.CORS_ALLOWED_ORIGINS);
  if (configuredOrigins.has(normalized)) {
    return normalized;
  }

  if (env?.CORS_ALLOW_DEV_ORIGINS === "true" && isLocalDevOrigin(normalized)) {
    return normalized;
  }

  return null;
}

function parseAllowedOrigins(raw: string | undefined): Set<string> {
  const origins = new Set<string>();
  for (const item of (raw ?? "").split(",")) {
    const normalized = normalizeOrigin(item);
    if (normalized) {
      origins.add(normalized);
    }
  }
  return origins;
}

function normalizeOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
}

function isLocalDevOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1"
    );
  } catch {
    return false;
  }
}
