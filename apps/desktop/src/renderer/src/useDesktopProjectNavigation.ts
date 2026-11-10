import type { AppServerClient } from "@legioncode/sdk";
import type { LocalWorkspaceProjectsResponse, ThreadId, WorkspaceId } from "@repo/platform-protocol";
import { useCallback, useEffect, useRef, useState } from "react";

export type DesktopProjectIntent = {
  readonly workspaceId: WorkspaceId;
  readonly action: { readonly kind: "create" } | { readonly kind: "open"; readonly threadId: ThreadId };
};

/** Canonical navigation read plus volatile picker intent, never a project registry/grant. */
export function useDesktopProjectNavigation(input: {
  client: Pick<AppServerClient, "listLocalWorkspaceProjects"> | null;
  enabled: boolean;
  revision: string | null;
}) {
  const [navigation, setNavigation] = useState<LocalWorkspaceProjectsResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [intent, setIntent] = useState<DesktopProjectIntent | null>(null);
  const currentIntent = useRef(intent);
  const request = useRef(0);
  const context = useRef(input);
  context.current = input;

  const refresh = useCallback(async (): Promise<void> => {
    if (!input.client || !input.enabled) return;
    const id = ++request.current;
    try {
      const result = await input.client.listLocalWorkspaceProjects();
      if (id !== request.current || context.current.client !== input.client || !context.current.enabled) return;
      setNavigation(result);
      setStatus("ready");
    } catch {
      if (id !== request.current || context.current.client !== input.client || !context.current.enabled) return;
      setStatus("error");
    }
  }, [input.client, input.enabled]);

  useEffect(() => {
    setNavigation(null);
    setStatus("loading");
    return () => { request.current += 1; };
  }, [input.client, input.enabled]);

  useEffect(() => { void refresh(); }, [refresh, input.revision]);

  const capture = useCallback((next: DesktopProjectIntent) => {
    currentIntent.current = next;
    setIntent(next);
    return next;
  }, []);
  const clear = useCallback((expected?: DesktopProjectIntent) => {
    if (expected && currentIntent.current !== expected) return;
    currentIntent.current = null;
    setIntent(null);
  }, []);

  return { navigation, status, refresh, intent, currentIntent, capture, clear };
}
