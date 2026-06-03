export type WebRoute =
  | { kind: "landing" }
  | { kind: "agents" }
  | { kind: "cloud" }
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

  if (normalizedPathname === "/") {
    return { kind: "landing" };
  }

  if (
    normalizedPathname === "/app" ||
    normalizedPathname === "/web-agents"
  ) {
    return { kind: "redirect", target: "/agents" };
  }

  if (
    normalizedPathname === "/agents" ||
    normalizedPathname.startsWith("/agents/")
  ) {
    return { kind: "agents" };
  }

  if (
    normalizedPathname === "/cloud" ||
    normalizedPathname.startsWith("/cloud/")
  ) {
    return { kind: "cloud" };
  }

  return { kind: "landing" };
}
