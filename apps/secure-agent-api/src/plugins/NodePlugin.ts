import { Sandbox } from "@cloudflare/sandbox";
import { IPlugin, PluginResult, LogCallback, PluginExecutionContext } from "../interfaces/types";
import { NodeTool } from "../schemas/node";
import { z } from "zod";
import { normalizeRunId } from "./security/PathGuard";
import { resolveScopedWorkspaceRoot } from "./security/WorkspaceScope";
import { runSafeCommand } from "./security/SafeCommand";
import {
  readToolboxCommandContext,
  withToolboxCommandContext,
} from "./security/ToolboxCommandContext";

const DEFAULT_ALLOWED_COMMANDS = ["node", "npm", "pnpm", "yarn", "npx", "tsx"];

const RunCommandPayloadSchema = z.object({
  action: z.literal("run"),
  runId: z.string().optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
});

const ExecuteCodePayloadSchema = z.object({
  runId: z.string().optional(),
  code: z.string().min(1),
  isTypeScript: z.boolean().optional(),
});

export class NodePlugin implements IPlugin {
  name = "node";
  tools = [NodeTool];

  async execute(
    sandbox: Sandbox,
    payload: unknown,
    onLog?: LogCallback,
    context?: PluginExecutionContext,
  ): Promise<PluginResult> {
    try {
      const toolboxContext = readToolboxCommandContext(payload);
      if (isRunActionPayload(payload)) {
        return await this.executeRunCommand(
          sandbox,
          payload,
          toolboxContext,
          onLog,
          context,
        );
      }
      return await this.executeCodeBlock(
        sandbox,
        payload,
        toolboxContext,
        onLog,
        context,
      );
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Node plugin execution failed";
      return { success: false, error: message };
    }
  }

  private async executeRunCommand(
    sandbox: Sandbox,
    payload: unknown,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    onLog?: LogCallback,
    context?: PluginExecutionContext,
  ): Promise<PluginResult> {
    const parsed = RunCommandPayloadSchema.parse(payload);
    const runId = normalizeRunId(parsed.runId ?? toolboxContext.runId);
    const workspaceRoot = resolveScopedWorkspaceRoot(context, runId);

    await runSafeCommand(
      sandbox,
      withToolboxCommandContext(
        { command: "mkdir", args: ["-p", workspaceRoot], runId },
        toolboxContext,
        "node.prepare_workspace",
      ),
      ["mkdir"],
    );

    const commandParts = normalizeCommandParts(parsed.command, parsed.args);
    const command = commandParts[0];
    if (!command) {
      return { success: false, error: "Missing command" };
    }
    const args = commandParts.slice(1);

    if (onLog) {
      onLog(`[node/plugin] Running ${command} in ${workspaceRoot}\n`);
    }

    const result = await runSafeCommand(
      sandbox,
      withToolboxCommandContext(
        { command, args, cwd: workspaceRoot, runId },
        toolboxContext,
        "node.run",
      ),
      DEFAULT_ALLOWED_COMMANDS,
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

  private async executeCodeBlock(
    sandbox: Sandbox,
    payload: unknown,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    onLog?: LogCallback,
    context?: PluginExecutionContext,
  ): Promise<PluginResult> {
    const parsed = ExecuteCodePayloadSchema.parse(payload);
    const runId = normalizeRunId(parsed.runId ?? toolboxContext.runId);
    const workspaceRoot = resolveScopedWorkspaceRoot(context, runId);

    await runSafeCommand(
      sandbox,
      withToolboxCommandContext(
        { command: "mkdir", args: ["-p", workspaceRoot], runId },
        toolboxContext,
        "node.prepare_workspace",
      ),
      ["mkdir"],
    );

    const ext = parsed.isTypeScript ? "ts" : "js";
    const fileName = `${workspaceRoot}/index.${ext}`;
    const runner = parsed.isTypeScript ? "tsx" : "node";
    await sandbox.writeFile(fileName, parsed.code);

    if (onLog) {
      onLog(`[node/plugin] Running ${runner} index.${ext}\n`);
    }

    const result = await runSafeCommand(
      sandbox,
      withToolboxCommandContext(
        { command: runner, args: [`index.${ext}`], cwd: workspaceRoot, runId },
        toolboxContext,
        "node.execute_code",
      ),
      DEFAULT_ALLOWED_COMMANDS,
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

function isRunActionPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const candidate = payload as { action?: unknown };
  return candidate.action === "run";
}

function normalizeCommandParts(command: string, args?: string[]): string[] {
  const disallowedShellTokens = /[|&;$`><\r\n]/;
  if (disallowedShellTokens.test(command)) {
    throw new Error("Unsafe shell token detected in command");
  }
  if (args && args.some((arg) => disallowedShellTokens.test(arg))) {
    throw new Error("Unsafe shell token detected in args");
  }

  if (args && args.length > 0) {
    return [command.trim(), ...args];
  }

  return command
    .trim()
    .split(/\s+/)
    .filter((segment) => segment.length > 0);
}
