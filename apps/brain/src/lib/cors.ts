interface CorsEnvConfig {
  CORS_ALLOWED_ORIGINS?: string;
  CORS_ALLOW_DEV_ORIGINS?: "true" | "false";
  FRONTEND_URL?: string;
  NODE_ENV?: string;
}

const BASE_CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Run-Id, x-vercel-ai-data-stream, x-ai-sdk-data-stream",
  "Access-Control-Expose-Headers": [
    "x-vercel-ai-data-stream",
    "x-ai-sdk-data-stream",
    "X-Engine-Version",
    "X-Run-Id",
    "X-Run-Engine-Runtime",
    "X-Shadowbox-Run-Engine-Name",
    "X-Shadowbox-Run-Engine-Git-Sha",
    "X-Shadowbox-Run-Engine-Started-At",
    "X-Shadowbox-Run-Engine-Boot-Id",
    "X-Shadowbox-Run-Engine-Fingerprint",
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

  const allowedOrigin = resolveAllowedOrigin(origin, request, env);
  if (!allowedOrigin) {
    return { Vary: "Origin" };
  }

  return {
    ...BASE_CORS_HEADERS,
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Credentials": "true",
  };
}

export function handleOptions(
  request: Request,
  env?: CorsEnvConfig,
): Response | null {
  if (request.method !== "OPTIONS") {
    return null;
  }

  const origin = request.headers.get("Origin");
  if (origin && !resolveAllowedOrigin(origin, request, env)) {
    return new Response(null, { status: 204, headers: { Vary: "Origin" } });
  }

  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(request, env),
  });
}

function resolveAllowedOrigin(
  origin: string,
  request: Request,
  env?: CorsEnvConfig,
): string | null {
  const normalized = normalizeOrigin(origin);
  if (!normalized) {
    return null;
  }

  const configuredOrigins = parseAllowedOrigins(env);
  if (configuredOrigins.has(normalized)) {
    return normalized;
  }

  if (env?.CORS_ALLOW_DEV_ORIGINS === "true" && isLocalDevOrigin(normalized)) {
    return normalized;
  }

  if (isLocalDevOrigin(normalized) && isLocalDevRequest(request.url)) {
    return normalized;
  }

  return null;
}

function parseAllowedOrigins(env?: CorsEnvConfig): Set<string> {
  const originList = new Set<string>();
  const raw = [env?.CORS_ALLOWED_ORIGINS, env?.FRONTEND_URL]
    .filter((value): value is string => typeof value === "string")
    .join(",");

  for (const candidate of raw.split(",")) {
    const normalized = normalizeOrigin(candidate);
    if (normalized) {
      originList.add(normalized);
    }
  }

  return originList;
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
    return isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

function isLocalDevRequest(urlValue: string): boolean {
  try {
    const url = new URL(urlValue);
    return isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[(.*)\]$/, "$1");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
}
