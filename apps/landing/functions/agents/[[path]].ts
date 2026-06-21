// apps/landing/functions/agents/[[path]].ts
//
// Cloudflare Pages Function: dispatches /agents/* from the landing
// app (legioncode.dev) to the agents web app (agents.legioncode.dev).
//
// Plan 018 §"Deployment Shape" Option B with cross-origin dispatch
// (subdomain split): the landing app serves the public marketing
// surface at the domain root, and /agents/* is forwarded to the
// agents app's own Cloudflare Pages project.
//
// Override the target via the AGENTS_ORIGIN Pages var (set in
// apps/landing/wrangler.jsonc) or a deploy-time binding.
//
// This function takes precedence over the catch-all
// /* /index.html 200 rule in apps/landing/public/_redirects.

interface Env {
  AGENTS_ORIGIN?: string;
}

const DEFAULT_AGENTS_ORIGIN = "https://agents.legioncode.dev";
const AGENTS_PROXY_TIMEOUT_MS = 30_000;
const processLogger = {
  info: (message: string, context: Record<string, unknown>) => {
    console.log(`[agents/proxy] ${message}`, context);
  },
  error: (message: string, context: Record<string, unknown>) => {
    console.error(`[agents/proxy] ${message}`, context);
  },
};

export const onRequest = async (context: {
  request: Request;
  env: Env;
}): Promise<Response> => {
  const origin = resolveAgentsOrigin(context.env.AGENTS_ORIGIN);
  const url = new URL(context.request.url);
  const target = buildAgentsTarget(origin, url);

  const proxied = new Request(target, context.request);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, AGENTS_PROXY_TIMEOUT_MS);
  try {
    processLogger.info("Forwarding request to agents app.", { origin, target });
    const response = await fetch(proxied, { signal: controller.signal });
    processLogger.info("Agents app responded.", {
      status: response.status,
      target,
    });
    return response;
  } catch (error) {
    const status = isAbortError(error) ? 504 : 502;
    processLogger.error("Agents app proxy failed.", {
      error: getErrorMessage(error),
      isAbort: isAbortError(error),
      target,
    });
    return new Response("Agents app is unavailable.", { status });
  } finally {
    clearTimeout(timeoutId);
  }
};

export function buildAgentsTarget(origin: string, requestUrl: URL): string {
  const upstreamPath =
    requestUrl.pathname.replace(/^\/agents(?=\/|$)/, "") || "/";
  return `${origin}${upstreamPath}${requestUrl.search}`;
}

function resolveAgentsOrigin(value: string | undefined): string {
  const rawOrigin = value?.trim() || DEFAULT_AGENTS_ORIGIN;
  let url: URL;
  try {
    url = new URL(rawOrigin);
  } catch {
    throw new Error(`resolveAgentsOrigin: Invalid AGENTS_ORIGIN: '${rawOrigin}'.`);
  }
  if (url.protocol !== "https:") {
    throw new Error(
      `resolveAgentsOrigin: AGENTS_ORIGIN must use https: '${rawOrigin}'.`,
    );
  }
  if (!url.hostname) {
    throw new Error(
      `resolveAgentsOrigin: AGENTS_ORIGIN must include a hostname: '${rawOrigin}'.`,
    );
  }
  return url.origin;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
