import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RunIdSchema,
  type AppServerClient,
  type HostedSession,
  type HostedSessionCreateRequest,
  type HostedSessionWorkspaceContext,
  type HostedWorkspaceListItem,
  type HostedWorkspaceSelection,
  type HostedWorkspaceSelectRequest,
} from "@legioncode/sdk";
import { HostedSessionParamsSchema } from "@repo/platform-protocol";
import { shouldRetainCurrentTitleProjection, usePendingTitleProjectionRefresh } from "@legioncode/client-ui";
import type { HostedAccountSnapshot } from "../../shared/hosted-account";

interface Options {
  readonly client: AppServerClient | null;
  readonly account: HostedAccountSnapshot | null;
  readonly enabled: boolean;
}
interface Connection {
  readonly client: AppServerClient;
  readonly target: HostedAccountSnapshot["target"];
  readonly accountId: string;
  readonly key: string;
}
interface Snapshot {
  readonly owner: Connection | null;
  readonly sessions: HostedSession[];
  readonly workspaces: HostedWorkspaceListItem[];
  readonly workspaceSelection: HostedWorkspaceSelection | null;
  readonly selectedSessionId: string | null;
  readonly initialized: boolean;
  readonly loading: boolean;
  readonly mutating: boolean;
  readonly pendingCreation: boolean;
  readonly error: string | null;
  readonly navigationError: string | null;
}
interface PendingCreation {
  readonly owner: Connection;
  readonly request: HostedSessionCreateRequest;
  readonly navigation: number;
  promise: Promise<HostedSession> | null;
}
interface CreationReceipt {
  readonly owner: Connection;
  readonly request: HostedSessionCreateRequest;
  readonly session: HostedSession;
}
interface TitleProjection {
  readonly owner: Connection;
  readonly lifetime: number;
  readonly readVersion: number;
  readonly mutationVersion: number;
  readonly sessions: HostedSession[];
}
const emptySnapshot: Snapshot = {
  owner: null, sessions: [], workspaces: [], workspaceSelection: null,
  selectedSessionId: null, initialized: false, loading: false,
  mutating: false, pendingCreation: false, error: null, navigationError: null,
};

/** Hosted metadata only. Session UUIDs never stand in for canonical Thread IDs. */
export function useDesktopHostedSessions({ client, account, enabled }: Options) {
  const accountId = account?.state === "signed_in" ? account.account?.id ?? null : null;
  const target = account?.target ?? null;
  const key = accountId && account
    ? JSON.stringify([account.target, accountId, account.generation]) : null;
  const connection = useMemo<Connection | null>(() => client && accountId && target && key
    ? Object.freeze({ client, target, accountId, key }) : null, [client, target, accountId, key]);
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [contextReload, setContextReload] = useState(0);
  const state = useRef(snapshot);
  const live = useRef({ connection, enabled, mounted: false, lifetime: 0 });
  live.current.connection = connection;
  live.current.enabled = enabled;
  const readVersion = useRef(0);
  const mutationVersion = useRef(0);
  const navigation = useRef(0);
  const mutation = useRef<{ owner: Connection; token: symbol } | null>(null);
  const creation = useRef<PendingCreation | null>(null);
  const creationReceipt = useRef<CreationReceipt | null>(null);

  const current = useCallback((owner: Connection, lifetime?: number) =>
    live.current.mounted && live.current.enabled && live.current.connection === owner &&
    (lifetime === undefined || lifetime === live.current.lifetime), []);
  const publish = useCallback((owner: Connection, patch: Partial<Snapshot>) => {
    if (!current(owner)) return;
    const previous = state.current.owner === owner ? state.current : emptySnapshot;
    state.current = { ...previous, ...patch, owner };
    setSnapshot(state.current);
  }, [current]);
  const requireConnection = useCallback(() => {
    const owner = live.current.connection;
    if (!owner || !current(owner)) throw new Error("Connect your hosted account before opening cloud tasks.");
    return owner;
  }, [current]);

  const reload = useCallback(async () => {
    const owner = live.current.connection;
    if (!owner || !current(owner)) return;
    const lifetime = live.current.lifetime;
    const version = ++readVersion.current;
    const revision = mutationVersion.current;
    publish(owner, { loading: true, mutating: mutation.current?.owner === owner, error: null });
    try {
      const [sessions, result] = await Promise.all([
        owner.client.listSessions(), owner.client.listHostedWorkspaces(),
      ]);
      if (!current(owner, lifetime) || version !== readVersion.current || revision !== mutationVersion.current) return;
      if (sessions.some((session) => session.userId !== owner.accountId) ||
          result.workspaces.some((item) => item.workspace.userId !== owner.accountId)) {
        throw new Error("Hosted records do not belong to the connected account.");
      }
      const previous = state.current.owner === owner ? state.current : emptySnapshot;
      let selectedSessionId = previous.selectedSessionId;
      let navigationError = previous.navigationError;
      const pending = creation.current?.owner === owner ? creation.current : null;
      const recovered = pending && sessions.find((session) => session.id === pending.request.sessionId);
      if (pending && recovered) {
        assertRecoveredSession(recovered, pending.request, owner.accountId);
        creationReceipt.current = { owner, request: pending.request, session: recovered };
        creation.current = null;
        if (pending.navigation === navigation.current) {
          selectedSessionId = recovered.id;
          navigationError = null;
          writeNavigationPreference(owner, recovered.id);
        }
      }
      if (!previous.initialized && !recovered) {
        const preference = readNavigationPreference(owner);
        if (preference.kind === "session") selectedSessionId = preference.sessionId;
        else if (preference.kind === "welcome" || preference.kind === "invalid") {
          selectedSessionId = null;
          navigationError = preference.kind === "invalid" ? "The saved cloud task selection is unavailable. Choose a task or start a new chat." : null;
        } else {
          const available = sessions.filter((session) => session.archivedAt === null);
          const inWorkspace = available.filter((session) => session.workspaceId === result.selection?.workspaceId);
          selectedSessionId = newestSession(inWorkspace.length ? inWorkspace : available)?.id ?? null;
        }
      }
      if (selectedSessionId) {
        navigationError = sessions.some((session) => session.id === selectedSessionId && session.archivedAt === null)
          ? null : "The previously selected cloud task is unavailable or archived. Choose a task or start a new chat.";
      }
      publish(owner, {
        sessions, workspaces: result.workspaces, workspaceSelection: result.selection,
        selectedSessionId, navigationError, initialized: true, pendingCreation: creation.current?.owner === owner,
      });
      setContextReload((value) => value + 1);
    } catch {
      if (current(owner, lifetime) && version === readVersion.current) {
        publish(owner, { error: "Cloud tasks and repositories could not be loaded. Try again." });
      }
    } finally {
      if (current(owner, lifetime) && version === readVersion.current) publish(owner, { loading: false });
    }
  }, [current, publish]);

  useEffect(() => {
    live.current.mounted = true;
    live.current.lifetime += 1;
    if (creation.current?.owner !== connection) creation.current = null;
    if (creationReceipt.current?.owner !== connection) creationReceipt.current = null;
    if (mutation.current?.owner !== connection) mutation.current = null;
    if (enabled && connection) void reload();
    return () => {
      live.current.mounted = false;
      live.current.lifetime += 1;
      readVersion.current += 1;
    };
  }, [connection, enabled, reload]);

  const perform = useCallback(async <T,>(operation: (owner: Connection, lifetime: number) => Promise<T>): Promise<T> => {
    const owner = requireConnection();
    if (mutation.current?.owner === owner) throw new Error("Wait for the current cloud task change to finish.");
    const token = Symbol();
    mutation.current = { owner, token };
    mutationVersion.current += 1;
    const lifetime = live.current.lifetime;
    publish(owner, { mutating: true, error: null });
    try {
      const result = await operation(owner, lifetime);
      if (!current(owner, lifetime)) throw new Error("The hosted account changed during this operation.");
      return result;
    } catch (error) {
      if (current(owner, lifetime)) publish(owner, { error: "The cloud task change could not be confirmed. Reload before retrying." });
      throw error;
    } finally {
      if (mutation.current?.token === token) {
        mutation.current = null;
        mutationVersion.current += 1;
        if (current(owner)) publish(owner, { mutating: false });
      }
    }
  }, [current, publish, requireConnection]);

  const selectNewChat = useCallback(() => {
    const owner = requireConnection();
    navigation.current += 1;
    writeNavigationPreference(owner, "welcome");
    publish(owner, { selectedSessionId: null, initialized: true, error: null, navigationError: null });
  }, [publish, requireConnection]);
  const selectSession = useCallback((id: string) => {
    const owner = requireConnection();
    const session = state.current.owner === owner && state.current.sessions.find((item) => item.id === id && item.archivedAt === null);
    if (!session) {
      publish(owner, { error: "Reload cloud tasks before opening this conversation." });
      return;
    }
    navigation.current += 1;
    writeNavigationPreference(owner, session.id);
    publish(owner, { selectedSessionId: session.id, initialized: true, error: null, navigationError: null });
  }, [publish, requireConnection]);

  const selectWorkspace = useCallback((request: HostedWorkspaceSelectRequest) => perform(async (owner, lifetime) => {
    if (creation.current?.owner === owner) throw new Error("Confirm the pending cloud task before changing repositories.");
    const selectedNavigation = navigation.current;
    const captured = { repository: { ...request.repository }, selectedBranch: request.selectedBranch };
    const selection = await owner.client.selectHostedWorkspace(captured);
    if (!current(owner, lifetime)) throw new Error("The hosted account changed during repository selection.");
    if (selection.repository.owner !== captured.repository.owner || selection.repository.name !== captured.repository.name ||
        selection.selectedBranch !== captured.selectedBranch) throw new Error("The hosted repository selection did not match the request.");
    const stillSelected = selectedNavigation === navigation.current;
    if (stillSelected) {
      navigation.current += 1;
      writeNavigationPreference(owner, "welcome");
    }
    publish(owner, { workspaceSelection: selection, initialized: true,
      ...(stillSelected ? { selectedSessionId: null, navigationError: null } : {}) });
    return selection;
  }), [current, perform, publish]);

  const sendCreation = useCallback((pending: PendingCreation): Promise<HostedSession> => {
    const owner = requireConnection();
    if (pending.owner !== owner) return Promise.reject(new Error("The pending cloud task belongs to another account connection."));
    if (pending.promise) return pending.promise;
    if (mutation.current?.owner === owner) return Promise.reject(new Error("Wait for the current cloud task change to finish."));
    creation.current = pending;
    publish(owner, { pendingCreation: true });
    const promise = perform(async (captured, lifetime) => {
      const session = await captured.client.createSession(pending.request);
      if (!current(captured, lifetime)) throw new Error("The hosted account changed during task creation.");
      assertCreatedSession(session, pending.request, captured.accountId);
      creationReceipt.current = { owner: captured, request: pending.request, session };
      if (creation.current === pending) creation.current = null;
      const sessions = state.current.sessions.filter((item) => item.id !== session.id).concat(session);
      const stillSelected = pending.navigation === navigation.current;
      if (stillSelected) writeNavigationPreference(captured, session.id);
      publish(captured, { sessions, initialized: true, pendingCreation: false,
        ...(stillSelected ? { selectedSessionId: session.id, navigationError: null } : {}) });
      return session;
    });
    pending.promise = promise;
    void promise.then(() => { pending.promise = null; }, () => { pending.promise = null; });
    return promise;
  }, [current, perform, publish, requireConnection]);

  const createSession = useCallback((input: { title?: string; mode?: string } = {}): Promise<HostedSession> => {
    const owner = requireConnection();
    const existing = creation.current?.owner === owner ? creation.current : null;
    const workspace = state.current.owner === owner ? state.current.workspaceSelection : null;
    if (!workspace) return Promise.reject(new Error("Choose a hosted repository before creating a cloud task."));
    const title = input.title?.trim() || "New task";
    const mode = input.mode?.trim() ?? "build";
    if (existing && (existing.request.title !== title || existing.request.mode !== mode ||
        existing.request.workspaceId !== workspace.workspaceId || existing.request.repository !== workspace.repository.fullName)) {
      return Promise.reject(new Error("Reload or retry the unchanged pending cloud task before creating another."));
    }
    return sendCreation(existing ?? {
      owner, navigation: navigation.current,
      request: Object.freeze({ sessionId: crypto.randomUUID(), runId: `run_${crypto.randomUUID().replaceAll("-", "")}`,
        workspaceId: workspace.workspaceId, repository: workspace.repository.fullName, title, mode }),
      promise: null,
    });
  }, [requireConnection, sendCreation]);

  const retryPendingCreation = useCallback((): Promise<HostedSession> => {
    const owner = requireConnection();
    const pending = creation.current?.owner === owner ? creation.current : null;
    if (pending) return sendCreation(pending);
    const receipt = creationReceipt.current?.owner === owner ? creationReceipt.current : null;
    if (!receipt) return Promise.reject(new Error("There is no retained cloud task creation to retry."));
    const session = state.current.owner === owner
      ? state.current.sessions.find((item) => item.id === receipt.request.sessionId) ?? receipt.session : receipt.session;
    assertRecoveredSession(session, receipt.request, owner.accountId);
    return Promise.resolve(session);
  }, [requireConnection, sendCreation]);

  const updateSession = useCallback((id: string, operation: (client: AppServerClient) => Promise<HostedSession>) =>
    perform(async (owner, lifetime) => {
      if (state.current.owner !== owner || !state.current.sessions.some((session) => session.id === id)) {
        throw new Error("Reload cloud tasks before changing this conversation.");
      }
      const session = await operation(owner.client);
      if (!current(owner, lifetime)) throw new Error("The hosted account changed during the task update.");
      if (session.id !== id || session.userId !== owner.accountId) throw new Error("The updated cloud task belongs to another account or conversation.");
      publish(owner, { sessions: state.current.sessions.map((item) => item.id === id ? session : item),
        ...(session.archivedAt !== null && state.current.selectedSessionId === id ? { selectedSessionId: null } : {}) });
      return session;
    }), [current, perform, publish]);
  const renameSession = useCallback((id: string, title: string) => updateSession(id, (api) => api.renameSession(id, title)), [updateSession]);
  const pinSession = useCallback((id: string) => updateSession(id, (api) => api.pinSession(id)), [updateSession]);
  const unpinSession = useCallback((id: string) => updateSession(id, (api) => api.unpinSession(id)), [updateSession]);
  const archiveSession = useCallback((id: string) => updateSession(id, (api) => api.archiveSession(id)), [updateSession]);
  const unarchiveSession = useCallback((id: string) => updateSession(id, (api) => api.unarchiveSession(id)), [updateSession]);

  const visible = snapshot.owner === connection ? snapshot : emptySnapshot;
  const readTitleProjection = useCallback(async (): Promise<TitleProjection> => {
    const owner = requireConnection();
    const lifetime = live.current.lifetime;
    const version = readVersion.current;
    const revision = mutationVersion.current;
    const sessions = await owner.client.listSessions();
    if (!current(owner, lifetime) || version !== readVersion.current || revision !== mutationVersion.current)
      throw new DOMException("Hosted title read changed scope.", "AbortError");
    if (sessions.some((session) => session.userId !== owner.accountId)) throw new Error("Hosted titles belong to another account.");
    return { owner, lifetime, readVersion: version, mutationVersion: revision, sessions };
  }, [current, requireConnection]);
  const mergeTitleProjection = useCallback((projection: TitleProjection) => {
    const { owner } = projection;
    if (!current(owner, projection.lifetime) || projection.readVersion !== readVersion.current ||
        projection.mutationVersion !== mutationVersion.current || state.current.owner !== owner) return;
    const incoming = new Map(projection.sessions.map((session) => [session.id, session]));
    const previous = state.current.sessions;
    const sessions = previous.map((session) => {
      const next = incoming.get(session.id);
      if (!next || shouldRetainCurrentTitleProjection(session, next)) return session;
      if (session.title === next.title && session.titleSource === next.titleSource && session.titleVersion === next.titleVersion &&
          session.titleStatus === next.titleStatus && session.updatedAt === next.updatedAt) return session;
      return { ...session, title: next.title, titleSource: next.titleSource, titleVersion: next.titleVersion,
        titleStatus: next.titleStatus, updatedAt: next.updatedAt > session.updatedAt ? next.updatedAt : session.updatedAt };
    });
    if (sessions.some((session, index) => session !== previous[index])) publish(owner, { sessions });
  }, [current, publish]);
  usePendingTitleProjectionRefresh({
    enabled: enabled && connection !== null && visible.initialized && !visible.loading,
    scopeKey: connection?.key ?? "", records: visible.sessions,
    readProjection: readTitleProjection, getRecords: titleProjectionRecords, onProjection: mergeTitleProjection,
  });
  const selectedSession = visible.sessions.find((session) => session.id === visible.selectedSessionId && session.archivedAt === null) ?? null;
  const savedRun = selectedSession?.activeRunId ?? selectedSession?.latestRunId ?? null;
  const runId = savedRun && RunIdSchema.safeParse(savedRun).success ? savedRun : null;
  const [context, setContext] = useState<{
    owner: Connection; sessionId: string; runId: string | null;
    value: HostedSessionWorkspaceContext | null; loading: boolean; error: string | null;
  } | null>(null);
  const contextSessionId = selectedSession?.id ?? null;
  const contextWorkspaceId = selectedSession?.workspaceId ?? null;
  const contextThreadId = selectedSession?.threadId ?? null;
  useEffect(() => {
    if (!enabled || !connection || !contextSessionId) return;
    let active = true;
    setContext({ owner: connection, sessionId: contextSessionId, runId, value: null, loading: true, error: null });
    void connection.client.getSessionWorkspaceContext(contextSessionId, runId ?? undefined).then((value) => {
      if (!active || !current(connection)) return;
      if (value.sessionId !== contextSessionId || value.workspaceId !== contextWorkspaceId ||
          (contextThreadId !== null && value.threadId !== contextThreadId)) throw new Error("Hosted task context changed scope.");
      setContext({ owner: connection, sessionId: contextSessionId, runId, value, loading: false, error: null });
    }).catch(() => {
      if (active && current(connection)) setContext({ owner: connection, sessionId: contextSessionId, runId,
        value: null, loading: false, error: "The saved cloud task's repository could not be loaded." });
    });
    return () => { active = false; };
  }, [connection, contextReload, contextSessionId, contextThreadId, contextWorkspaceId, current, enabled, runId]);
  const visibleContext = context?.owner === connection && context.sessionId === contextSessionId && context.runId === runId ? context : null;
  return {
    sessions: visible.sessions, workspaces: visible.workspaces, workspaceSelection: visible.workspaceSelection,
    selectedSession, runId, workspaceContext: visibleContext?.value ?? null,
    loading: visible.loading, mutating: visible.mutating, pendingCreation: visible.pendingCreation,
    error: visible.error ?? visible.navigationError ?? (savedRun && !runId ? "The saved cloud task has an invalid run identity. Open another task or start a new chat." : null),
    contextLoading: visibleContext?.loading ?? false, contextError: visibleContext?.error ?? null,
    reload, selectNewChat, selectSession, selectWorkspace, createSession, retryPendingCreation,
    renameSession, pinSession, unpinSession, archiveSession, unarchiveSession,
  };
}

function titleProjectionRecords(projection: TitleProjection): HostedSession[] { return projection.sessions; }

type NavigationPreference = { kind: "none" | "welcome" | "invalid" } | { kind: "session"; sessionId: string };
function navigationPreferenceKey(owner: Connection): string {
  return `legioncode.desktop.hosted.navigation:${JSON.stringify([owner.target, owner.accountId])}`;
}
function readNavigationPreference(owner: Connection): NavigationPreference {
  try {
    const value = window.localStorage.getItem(navigationPreferenceKey(owner));
    if (value === null) return { kind: "none" };
    if (value === "welcome") return { kind: "welcome" };
    return HostedSessionParamsSchema.safeParse({ sessionId: value }).success
      ? { kind: "session", sessionId: value } : { kind: "invalid" };
  } catch {
    // Optional navigation storage never supplies hosted records or blocks their server read.
    return { kind: "none" };
  }
}
function writeNavigationPreference(owner: Connection, value: string): void {
  if (value !== "welcome" && !HostedSessionParamsSchema.safeParse({ sessionId: value }).success) return;
  try { window.localStorage.setItem(navigationPreferenceKey(owner), value); }
  catch { /* Unavailable UI preference storage cannot prevent canonical hosted operations. */ }
}

function assertCreatedSession(session: HostedSession, request: HostedSessionCreateRequest, accountId: string): void {
  assertFrozenSessionIdentity(session, request, accountId);
  if (session.activeRunId !== request.runId) {
    throw new Error("The created cloud task did not match its frozen request.");
  }
}
function assertRecoveredSession(session: HostedSession, request: HostedSessionCreateRequest, accountId: string): void {
  assertFrozenSessionIdentity(session, request, accountId);
  if ((session.activeRunId ?? session.latestRunId ?? null) !== request.runId) {
    throw new Error("The recovered cloud task did not match its frozen run.");
  }
}
function assertFrozenSessionIdentity(session: HostedSession, request: HostedSessionCreateRequest, accountId: string): void {
  if (session.userId !== accountId || session.id !== request.sessionId ||
      session.workspaceId !== request.workspaceId || session.repository !== request.repository || session.mode !== request.mode) {
    throw new Error("The cloud task did not match its frozen request.");
  }
}
function newestSession(sessions: HostedSession[]): HostedSession | null {
  return sessions.reduce<HostedSession | null>((latest, session) => !latest || session.updatedAt > latest.updatedAt ? session : latest, null);
}
