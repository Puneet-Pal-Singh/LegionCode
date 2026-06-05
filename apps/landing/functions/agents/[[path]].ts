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

export const onRequest = async (context: {
  request: Request;
  env: Env;
}): Promise<Response> => {
  const origin = resolveAgentsOrigin(context.env.AGENTS_ORIGIN);
  const url = new URL(context.request.url);
  const target = `${origin}${url.pathname}${url.search}`;

  const proxied = new Request(target, context.request);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, AGENTS_PROXY_TIMEOUT_MS);
  try {
    return await fetch(proxied, { signal: controller.signal });
  } catch (error) {
    const status = isAbortError(error) ? 504 : 502;
    return new Response("Agents app is unavailable.", { status });
  } finally {
    clearTimeout(timeoutId);
  }
};

function resolveAgentsOrigin(value: string | undefined): string {
  const rawOrigin = value?.trim() || DEFAULT_AGENTS_ORIGIN;
  const url = new URL(rawOrigin);
  if (url.protocol !== "https:" || !url.hostname) {
    throw new Error("AGENTS_ORIGIN must be a valid HTTPS origin.");
  }
  return url.origin;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
