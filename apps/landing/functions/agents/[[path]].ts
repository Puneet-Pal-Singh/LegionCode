import {
  buildOriginTarget,
  proxyOriginRequest,
  resolveHttpsOrigin,
} from "../_shared/origin-proxy";

interface Env {
  AGENTS_ORIGIN?: string;
}

const DEFAULT_AGENTS_ORIGIN = "https://agents.legioncode.dev";

export const onRequest = async (context: {
  request: Request;
  env: Env;
}): Promise<Response> => {
  const origin = resolveAgentsOrigin(context.env.AGENTS_ORIGIN);
  return proxyOriginRequest({
    request: context.request,
    origin,
    publicPrefix: "/agents",
    serviceLabel: "Agents app",
  });
};

export function buildAgentsTarget(origin: string, requestUrl: URL): string {
  return buildOriginTarget(origin, requestUrl, "/agents");
}

export function resolveAgentsOrigin(value: string | undefined): string {
  return resolveHttpsOrigin(
    value,
    DEFAULT_AGENTS_ORIGIN,
    "AGENTS_ORIGIN",
  );
}
