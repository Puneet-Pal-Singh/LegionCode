import path from "node:path";
import type { PluginExecutionContext } from "../../interfaces/types";

const SANDBOX_WORKSPACE_ROOT_PREFIX = "/home/sandbox/checkouts/";

/** Resolves a plugin filesystem root from the server-issued execution scope. */
export function resolveScopedWorkspaceRoot(
  context: PluginExecutionContext | undefined,
  auditRunId: string,
): string {
  const scope = context?.workspaceScope;
  if (!scope) {
    throw new Error("A server-issued workspace scope is required for plugin execution");
  }
  if (scope.runId !== auditRunId) {
    throw new Error("Plugin run id does not match the server-issued workspace scope");
  }

  const root = scope.root;
  if (
    !root ||
    root.includes("\0") ||
    root.includes("\r") ||
    root.includes("\n") ||
    !path.posix.isAbsolute(root) ||
    path.posix.normalize(root) !== root ||
    !root.startsWith(SANDBOX_WORKSPACE_ROOT_PREFIX)
  ) {
    throw new Error("Invalid server-issued workspace root");
  }
  return root;
}
