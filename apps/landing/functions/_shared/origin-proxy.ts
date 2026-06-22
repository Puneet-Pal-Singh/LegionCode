const PROXY_TIMEOUT_MS = 30_000;

interface OriginProxyOptions {
  request: Request;
  origin: string;
  publicPrefix: string;
  serviceLabel: string;
}

export async function proxyOriginRequest({
  request,
  origin,
  publicPrefix,
  serviceLabel,
}: OriginProxyOptions): Promise<Response> {
  const target = buildOriginTarget(origin, new URL(request.url), publicPrefix);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
  try {
    console.log(`[${serviceLabel}/proxy] Forwarding request.`, { target });
    return await fetch(new Request(target, request), {
      signal: controller.signal,
    });
  } catch (error) {
    const timedOut = isAbortError(error);
    console.error(`[${serviceLabel}/proxy] Upstream request failed.`, {
      error: getErrorMessage(error),
      target,
      timedOut,
    });
    return new Response(`${serviceLabel} is unavailable.`, {
      status: timedOut ? 504 : 502,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

export function buildOriginTarget(
  origin: string,
  requestUrl: URL,
  publicPrefix: string,
): string {
  const escapedPrefix = publicPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const upstreamPath =
    requestUrl.pathname.replace(
      new RegExp(`^${escapedPrefix}(?=/|$)`),
      "",
    ) || "/";
  return `${origin}${upstreamPath}${requestUrl.search}`;
}

export function resolveHttpsOrigin(
  value: string | undefined,
  defaultOrigin: string,
  variableName: string,
): string {
  const rawOrigin = value?.trim() || defaultOrigin;
  let url: URL;
  try {
    url = new URL(rawOrigin);
  } catch {
    throw new Error(`${variableName} must be a valid URL: '${rawOrigin}'.`);
  }
  if (url.protocol !== "https:" || !url.hostname) {
    throw new Error(`${variableName} must use https with a hostname.`);
  }
  return url.origin;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
