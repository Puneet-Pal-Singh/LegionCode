import type { Sandbox } from "@cloudflare/sandbox";
import { resolveWorkspacePath } from "../security/PathGuard";
import { runSafeCommand } from "../security/SafeCommand";
import {
  type ToolboxCommandContext,
  withToolboxCommandContext,
} from "../security/ToolboxCommandContext";

export interface WorkspaceToolContext {
  sandbox: Sandbox;
  workspaceRoot: string;
  toolboxContext: ToolboxCommandContext;
  runId: string;
}

export class WorkspacePathResolver {
  async resolve(
    context: WorkspaceToolContext,
    inputPath: string,
    operation: string,
  ): Promise<string> {
    const targetPath = resolveWorkspacePath(context.workspaceRoot, inputPath);
    const result = await runSafeCommand(
      context.sandbox,
      withToolboxCommandContext(
        {
          command: "realpath",
          args: ["-m", "--", targetPath],
          runId: context.runId,
        },
        context.toolboxContext,
        operation,
      ),
      ["realpath"],
    );
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || "Unable to resolve workspace path");
    }
    return assertWithinWorkspace(context.workspaceRoot, result.stdout.trim());
  }
}

function assertWithinWorkspace(
  workspaceRoot: string,
  resolvedPath: string,
): string {
  const rootPrefix = workspaceRoot.endsWith("/")
    ? workspaceRoot
    : `${workspaceRoot}/`;
  if (resolvedPath !== workspaceRoot && !resolvedPath.startsWith(rootPrefix)) {
    throw new Error("Access Denied: resolved path escapes workspace root");
  }
  return resolvedPath;
}
