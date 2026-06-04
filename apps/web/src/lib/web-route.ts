export type WebRoute =
  | { kind: "agents" }
  | { kind: "redirect"; target: string };

function normalizePathname(pathname: string): string {
  const trimmed = pathname.trim();
  if (!trimmed || trimmed === "/") {
    return "/";
  }
  return trimmed.replace(/\/+$/, "");
}

export function buildAgentsRedirectUrl(search: string, hash: string): string {
  return `/agents${search}${hash}`;
}

export function resolveWebRoute(pathname: string): WebRoute {
  const normalizedPathname = normalizePathname(pathname);

  if (normalizedPathname === "/app" || normalizedPathname === "/web-agents") {
    return { kind: "redirect", target: "/agents" };
  }

  return { kind: "agents" };
}
