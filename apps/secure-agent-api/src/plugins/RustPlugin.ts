import { Sandbox } from "@cloudflare/sandbox";
import { IPlugin, PluginExecutionContext, PluginResult, LogCallback } from "../interfaces/types";
import { RustTool } from "../schemas/rust";
import { runSafeCommand } from "./security/SafeCommand";
import { normalizeRunId } from "./security/PathGuard";
import { resolveScopedWorkspaceRoot } from "./security/WorkspaceScope";
import {
  readToolboxCommandContext,
  withToolboxCommandContext,
} from "./security/ToolboxCommandContext";

export class RustPlugin implements IPlugin {
  name = "rust";
  tools = [RustTool];

  async execute(
    sandbox: Sandbox,
    payload: { code: string },
    onLog?: LogCallback,
    context?: PluginExecutionContext,
  ): Promise<PluginResult> {
    const toolboxContext = readToolboxCommandContext(payload);
    const runId = normalizeRunId(toolboxContext.runId);
    const workspaceRoot = resolveScopedWorkspaceRoot(context, runId);
    const fileName = "main.rs";
    const binaryName = "main_bin";

    await runSafeCommand(
      sandbox,
      withToolboxCommandContext(
        { command: "mkdir", args: ["-p", workspaceRoot], runId },
        toolboxContext,
        "rust.prepare_workspace",
      ),
      ["mkdir"],
    );

    await sandbox.writeFile(`${workspaceRoot}/${fileName}`, payload.code);

    // 1. Compile Phase
    if (onLog) onLog(`[Rust] Compiling ${fileName}...\n`);
    const compile = await runSafeCommand(
      sandbox,
      withToolboxCommandContext(
        {
          command: "rustc",
          args: [fileName, "-o", binaryName],
          cwd: workspaceRoot,
          runId,
        },
        toolboxContext,
        "rust.compile",
      ),
      ["rustc"],
    );

    if (compile.exitCode !== 0) {
      if (onLog) onLog(`\x1b[31m[Build Error]\n${compile.stderr}\x1b[0m`);
      return {
        success: false,
        output: compile.stdout,
        error: "Compilation failed",
        logs: [compile.stderr],
      };
    }

    // 2. Execution Phase
    if (onLog) onLog(`[Rust] Successfully compiled. Executing...\n`);
    const result = await runSafeCommand(
      sandbox,
      withToolboxCommandContext(
        {
          command: `./${binaryName}`,
          cwd: workspaceRoot,
          runId,
        },
        toolboxContext,
        "rust.execute",
      ),
      [`./${binaryName}`],
    );

    if (onLog) {
      if (result.stdout) onLog(result.stdout);
      if (result.stderr) onLog(`\x1b[31m${result.stderr}\x1b[0m`);
    }

    return {
      success: result.exitCode === 0,
      output: result.stdout,
      error: result.exitCode !== 0 ? result.stderr : undefined,
    };
  }
}
