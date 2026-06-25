import {
  buildOriginTarget,
  proxyOriginRequest,
  resolveHttpsOrigin,
} from "../_shared/origin-proxy";

interface Env {
  DOCS_ORIGIN?: string;
}

const DEFAULT_DOCS_ORIGIN = "https://shadowbox-docs.pages.dev";

export const onRequest = async (context: {
  request: Request;
  env: Env;
}): Promise<Response> => {
  return proxyOriginRequest({
    request: context.request,
    origin: resolveDocsOrigin(context.env.DOCS_ORIGIN),
    publicPrefix: "/docs",
    serviceLabel: "Docs app",
  });
};

export function buildDocsTarget(origin: string, requestUrl: URL): string {
  return buildOriginTarget(origin, requestUrl, "/docs");
}

export function resolveDocsOrigin(value: string | undefined): string {
  return resolveHttpsOrigin(value, DEFAULT_DOCS_ORIGIN, "DOCS_ORIGIN");
}
