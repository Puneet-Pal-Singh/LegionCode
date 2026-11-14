import {
  ChatErrorNotice,
  ClientShellLoading,
  ConversationHero,
} from "@legioncode/client-ui";
import type { AppServerClient, LocalTurnConfigurationOptions } from "@legioncode/sdk";
import type { LocalWorkspaceGrant } from "@repo/platform-protocol";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

type BootstrapClient = Pick<AppServerClient, "initialize" | "getWorkspaceGrant">;

export type DesktopWorkspaceBootstrapState =
  | { status: "idle" | "connecting" | "loading" | "ready" }
  | { status: "error"; phase: "initialize" | "workspace"; message: string };

interface BootstrapOptions {
  client: BootstrapClient | null;
  environmentReady: boolean;
  scope: { current: number };
  commandActive: { current: boolean };
  pickerOpen: boolean;
  onScopeReset: () => void;
  onReadStart: () => void;
  onWorkspaceReady: () => void;
  onWorkspaceUnavailable: () => void;
  onInitializeError: () => void;
}

interface ReadRequest {
  client: BootstrapClient;
  scope: number;
}

/** Owns Desktop bootstrap reads and delivery state; grants remain SDK/server results. */
export function useDesktopWorkspaceBootstrap(options: BootstrapOptions) {
  const latest = useRef(options);
  latest.current = options;
  const activeRead = useRef<ReadRequest | null>(null);
  const context = useRef<{ client: BootstrapClient | null; ready: boolean }>({
    client: null,
    ready: false,
  });
  const [sdkReady, setSdkReady] = useState(false);
  const [configurationOptions, setConfigurationOptions] = useState<LocalTurnConfigurationOptions | null>(null);
  const [workspace, setWorkspace] = useState<LocalWorkspaceGrant | null>(null);
  const [state, setState] = useState<DesktopWorkspaceBootstrapState>({ status: "idle" });
  const stateRef = useRef(state);

  const publish = useCallback((next: DesktopWorkspaceBootstrapState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const isCurrent = useCallback((request: ReadRequest): boolean =>
    activeRead.current === request &&
    latest.current.client === request.client &&
    latest.current.environmentReady &&
    latest.current.scope.current === request.scope,
  []);

  const readWorkspace = useCallback(async (request: ReadRequest): Promise<void> => {
    if (!isCurrent(request)) return;
    publish({ status: "loading" });
    setWorkspace(null);
    latest.current.onReadStart();
    let nextWorkspace: LocalWorkspaceGrant | null;
    try {
      nextWorkspace = await request.client.getWorkspaceGrant();
    } catch {
      if (!isCurrent(request)) return;
      setWorkspace(null);
      publish({ status: "error", phase: "workspace", message: "The local workspace grant could not be loaded." });
      latest.current.onWorkspaceUnavailable();
      activeRead.current = null;
      return;
    }
    if (!isCurrent(request)) return;
    setWorkspace(nextWorkspace);
    publish({ status: "ready" });
    activeRead.current = null;
    if (nextWorkspace?.readiness === "ready") latest.current.onWorkspaceReady();
    else latest.current.onWorkspaceUnavailable();
  }, [isCurrent, publish]);

  const initialize = useCallback(() => {
    const current = latest.current;
    activeRead.current = null;
    context.current = { client: current.client, ready: current.environmentReady };
    setSdkReady(false);
    setConfigurationOptions(null);
    setWorkspace(null);
    current.onScopeReset();
    if (!current.client || !current.environmentReady) {
      publish({ status: "idle" });
      return;
    }
    const request: ReadRequest = { client: current.client, scope: current.scope.current };
    activeRead.current = request;
    publish({ status: "connecting" });
    void request.client.initialize().then((initialized) => {
      if (!isCurrent(request)) return;
      setConfigurationOptions(initialized.localTurnConfiguration ?? null);
      setSdkReady(true);
      void readWorkspace(request);
    }).catch(() => {
      if (!isCurrent(request)) return;
      activeRead.current = null;
      publish({ status: "error", phase: "initialize", message: "The local Desktop connection could not be initialized." });
      latest.current.onInitializeError();
    });
  }, [isCurrent, publish, readWorkspace]);

  useEffect(() => {
    initialize();
    return () => {
      // Discard late UI delivery; the transport/runtime still owns any pending resource.
      activeRead.current = null;
    };
  }, [options.client, options.environmentReady, initialize]);

  const retry = useCallback(() => {
    const current = latest.current;
    const failed = stateRef.current;
    if (failed.status !== "error" || activeRead.current || !current.client ||
        !current.environmentReady || current.commandActive.current || current.pickerOpen) return;
    if (failed.phase === "initialize") {
      initialize();
      return;
    }
    const request: ReadRequest = { client: current.client, scope: current.scope.current };
    activeRead.current = request;
    void readWorkspace(request);
  }, [initialize, readWorkspace]);

  const acceptWorkspace = useCallback((next: LocalWorkspaceGrant | null) => {
    // Successful explicit grant/revoke supersedes any older bootstrap response.
    activeRead.current = null;
    setWorkspace(next);
    publish({ status: "ready" });
  }, [publish]);

  const contextMatches = context.current.client === options.client &&
    context.current.ready === options.environmentReady;
  const visibleState: DesktopWorkspaceBootstrapState = contextMatches
    ? state
    : { status: options.client && options.environmentReady ? "connecting" : "idle" };
  return {
    sdkReady: contextMatches && sdkReady,
    configurationOptions: contextMatches ? configurationOptions : null,
    workspace: contextMatches ? workspace : null,
    state: visibleState,
    retry,
    acceptWorkspace,
  };
}

export function DesktopWorkspaceBootstrapHero({
  workspace,
  state,
  threadLoadState,
  threadError,
  onRetryThreads,
  onChoose,
  onRetry,
  canChoose,
  canRetry,
  showProjectChip = true,
  children,
}: {
  workspace: LocalWorkspaceGrant | null;
  state: DesktopWorkspaceBootstrapState;
  threadLoadState: "loading" | "ready" | "error";
  threadError: string | null;
  onRetryThreads: () => void;
  onChoose: () => void;
  onRetry: () => void;
  canChoose: boolean;
  canRetry: boolean;
  showProjectChip?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-3 py-3 sm:px-6 sm:py-4">
    <ConversationHero projectName={workspace?.displayName} onProjectClick={onChoose} showProjectChip={showProjectChip}>
      {state.status === "connecting" || state.status === "loading" ? (
        <BootstrapLoading label={state.status === "connecting" ? "Connecting Desktop" : "Restoring workspace access"} />
      ) : state.status === "error" ? (
        <ChatErrorNotice
          message={state.message}
          remediation="Try loading the saved workspace again."
          actionLabel="Retry"
          onOpen={canRetry ? onRetry : undefined}
        />
      ) : workspace && workspace.readiness !== "ready" ? (
        <ChatErrorNotice
          message={workspace.reason ?? "Local workspace access is unavailable."}
          remediation="Choose the folder again to confirm local workspace access."
          actionLabel="Choose folder"
          onOpen={canChoose ? onChoose : undefined}
        />
      ) : workspace?.readiness === "ready" && (threadError || threadLoadState === "error") ? (
        <ChatErrorNotice
          message={threadError ?? "The local task list could not be loaded."}
          remediation={threadError ? "Select an existing task or use New task to try again." : "Try loading the project's tasks again."}
          actionLabel="Retry"
          onOpen={!threadError && canRetry ? onRetryThreads : undefined}
        />
      ) : workspace?.readiness === "ready" && threadLoadState === "loading" ? (
        <BootstrapLoading label="Loading conversation" />
      ) : null}
      {children}
    </ConversationHero>
    </div>
  );
}

function BootstrapLoading({ label }: { label: string }) {
  return (
    <div className="my-3 [&>.lc-client-screen]:!h-auto [&>.lc-client-screen]:!w-full [&>.lc-client-screen]:!bg-transparent">
      <ClientShellLoading label={label} />
    </div>
  );
}
