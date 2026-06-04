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

export const onRequest = async (context: {
  request: Request;
  env: Env;
}): Promise<Response> => {
  const origin = (context.env.AGENTS_ORIGIN || DEFAULT_AGENTS_ORIGIN).replace(
    /\/+$/,
    "",
  );
  const url = new URL(context.request.url);
  const target = `${origin}${url.pathname}${url.search}`;

  const proxied = new Request(target, context.request);
  return fetch(proxied);
};
