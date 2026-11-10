import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppServerClientError, type AppServerClient, type HostedWorkspaceConfiguration } from "@legioncode/sdk";

export type HostedWorkspaceConfigurationClient = Pick<AppServerClient,
  "readHostedWorkspaceConfiguration" | "updateHostedWorkspaceConfiguration" | "listRepositoryBranches">;

type Scope = {
  client: HostedWorkspaceConfigurationClient;
  workspaceId: string;
  key: string;
};
type EditorError = { message: string; recovery: "reload" | "close" };
type EditorState = {
  scope: Scope;
  status: "loading" | "ready" | "saving" | "recovery_required" | "unavailable";
  configuration: HostedWorkspaceConfiguration | null;
  name: string;
  branch: string;
  branches: readonly { name: string }[];
  branchState: "loading" | "ready" | "error";
  error: EditorError | null;
  notice: string | null;
};

const emptyState = (scope: Scope): EditorState => ({
  scope, status: "loading", configuration: null, name: "", branch: "",
  branches: [], branchState: "loading", error: null, notice: null,
});

function describeError(error: unknown, saving: boolean): EditorError {
  if (error instanceof AppServerClientError) {
    const server = error.serverError;
    const operationCode = server && "operationCode" in server ? server.operationCode : undefined;
    if (server?.code === "unauthorized" || server?.statusCode === 401)
      return { message: "Sign in again before editing this project's settings.", recovery: "close" };
    if (server?.code === "forbidden" || server?.statusCode === 403)
      return { message: "You no longer have access to this project.", recovery: "close" };
    if (server?.code === "not_found" || server?.statusCode === 404)
      return { message: "This saved project is unavailable. Choose another project.", recovery: "close" };
    if (operationCode?.includes("REPOSITORY_IDENTITY"))
      return { message: "This project's repository identity is unavailable or changed. Settings cannot be saved until that identity is safely recovered.", recovery: "close" };
    if (server?.statusCode === 409 || server?.code === "conflict")
      return { message: "These settings changed elsewhere. Your draft is still shown. Reload saved settings before saving again.", recovery: "reload" };
  }
  return {
    message: saving
      ? "The save could not be confirmed. Your draft is still shown. Reload saved settings to check the result before saving again."
      : "Project settings could not be loaded. Try again.",
    recovery: "reload",
  };
}

/** Draft-only controller. The supplied authenticated SDK and server retain saved settings and CAS ownership. */
export function useHostedWorkspaceConfiguration({ client, workspaceId, scopeKey, onSaved }: {
  client: HostedWorkspaceConfigurationClient;
  workspaceId: string;
  /** Host-provided account/session/environment generation; never inferred from a repository name. */
  scopeKey: string;
  onSaved?: (configuration: HostedWorkspaceConfiguration) => void | Promise<void>;
}) {
  const scope = useMemo(() => ({ client, workspaceId, key: scopeKey }), [client, workspaceId, scopeKey]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const mountedScope = useRef<Scope | null>(null);
  const generation = useRef(0);
  const branchRequest = useRef(0);
  const savingScope = useRef<Scope | null>(null);
  const savedCallback = useRef(onSaved);
  savedCallback.current = onSaved;
  const [stored, setStored] = useState<EditorState>(() => emptyState(scope));
  const storedRef = useRef(stored);
  storedRef.current = stored;
  // Suppress the previous account/workspace synchronously, before effect cleanup.
  const state = stored.scope === scope ? stored : emptyState(scope);
  const isCurrent = useCallback((requestGeneration: number) =>
    mountedScope.current === scope && currentScope.current === scope && generation.current === requestGeneration,
  [scope]);

  const loadBranches = useCallback(async (configuration: HostedWorkspaceConfiguration, requestGeneration: number) => {
    const request = ++branchRequest.current;
    if (!isCurrent(requestGeneration)) return;
    setStored((value) => value.scope === scope ? { ...value, branchState: "loading" } : value);
    try {
      const result = await scope.client.listRepositoryBranches({
        owner: configuration.repository.owner, repo: configuration.repository.name, perPage: 100,
      });
      if (!isCurrent(requestGeneration) || branchRequest.current !== request) return;
      // A saved branch may be outside the first response page; retain its acknowledged value.
      const names = [...new Set([configuration.selectedBranch, ...result.branches.map((branch) => branch.name)])];
      setStored((value) => value.scope === scope
        ? { ...value, branches: names.map((name) => ({ name })), branchState: "ready" }
        : value);
    } catch {
      if (isCurrent(requestGeneration) && branchRequest.current === request)
        setStored((value) => value.scope === scope ? { ...value, branchState: "error" } : value);
    }
  }, [scope, isCurrent]);

  const reload = useCallback(async () => {
    if (savingScope.current === scope) return;
    const requestGeneration = ++generation.current;
    branchRequest.current += 1;
    setStored(emptyState(scope));
    if (!scope.key || !scope.workspaceId) {
      setStored({ ...emptyState(scope), status: "unavailable", error: {
        message: "Choose an authenticated cloud project before editing its settings.", recovery: "close",
      } });
      return;
    }
    try {
      const configuration = await scope.client.readHostedWorkspaceConfiguration({ workspaceId: scope.workspaceId });
      if (!isCurrent(requestGeneration)) return;
      if (configuration.workspaceId !== scope.workspaceId) throw new Error("Configuration scope mismatch");
      setStored({ ...emptyState(scope), status: "ready", configuration,
        name: configuration.name, branch: configuration.selectedBranch });
      void loadBranches(configuration, requestGeneration);
    } catch (error) {
      if (isCurrent(requestGeneration))
        setStored({ ...emptyState(scope), status: "unavailable", error: describeError(error, false) });
    }
  }, [scope, isCurrent, loadBranches]);

  useEffect(() => {
    mountedScope.current = scope;
    void reload();
    return () => {
      generation.current += 1;
      branchRequest.current += 1;
      if (mountedScope.current === scope) mountedScope.current = null;
    };
  }, [scope, reload]);

  const change = (field: "name" | "branch", value: string) => {
    if (currentScope.current !== scope) return;
    setStored((current) => current.scope === scope && current.status === "ready"
      ? { ...current, [field]: value, error: null, notice: null }
      : current);
  };
  const save = async () => {
    const current = storedRef.current;
    if (current.scope !== scope || currentScope.current !== scope || current.status !== "ready" ||
        !current.configuration || savingScope.current === scope) return;
    const name = current.name.trim();
    const branchChanged = current.branch !== current.configuration.selectedBranch;
    if (!name || name.length > 200 || !current.branch ||
        (branchChanged && (current.branchState !== "ready" || !current.branches.some((branch) => branch.name === current.branch)))) return;
    const patch = {
      ...(name !== current.configuration.name ? { name } : {}),
      ...(branchChanged ? { selectedBranch: current.branch } : {}),
    };
    if (Object.keys(patch).length === 0) return;
    const requestGeneration = generation.current;
    savingScope.current = scope;
    setStored({ ...current, status: "saving", error: null, notice: null });
    let saved: HostedWorkspaceConfiguration;
    try {
      saved = await scope.client.updateHostedWorkspaceConfiguration({
        workspaceId: scope.workspaceId, expectedVersion: current.configuration.version, patch,
      });
      if (!isCurrent(requestGeneration)) return;
      if (saved.workspaceId !== scope.workspaceId) throw new Error("Configuration scope mismatch");
    } catch (error) {
      if (isCurrent(requestGeneration))
        setStored((value) => value.scope === scope
          ? { ...value, status: "recovery_required", error: describeError(error, true), notice: null }
          : value);
      return;
    } finally {
      if (savingScope.current === scope) savingScope.current = null;
    }
    if (!isCurrent(requestGeneration)) return;
    setStored((value) => value.scope === scope
      ? { ...value, status: "ready", configuration: saved,
          name: saved.name, branch: saved.selectedBranch, error: null, notice: "Project settings saved." }
      : value);
    try {
      await savedCallback.current?.(saved);
    } catch {
      // A failed navigation refresh cannot turn an acknowledged write into an unknown save.
      if (isCurrent(requestGeneration))
        setStored((value) => value.scope === scope && value.configuration === saved
          ? { ...value, notice: "Project settings saved. Reopen the project list to refresh it." }
          : value);
    }
  };
  const dirty = state.configuration &&
    (state.name.trim() !== state.configuration.name || state.branch !== state.configuration.selectedBranch);
  const canSave = state.status === "ready" && Boolean(dirty) &&
    state.name.trim().length > 0 && state.name.trim().length <= 200 && Boolean(state.branch) &&
    (state.branch === state.configuration?.selectedBranch ||
      (state.branchState === "ready" && state.branches.some((branch) => branch.name === state.branch)));
  return { ...state, canSave, save, reload,
    changeName: (value: string) => change("name", value),
    changeBranch: (value: string) => change("branch", value),
    retryBranches: () => {
      if (state.configuration && state.status === "ready")
        void loadBranches(state.configuration, generation.current);
    },
  };
}
