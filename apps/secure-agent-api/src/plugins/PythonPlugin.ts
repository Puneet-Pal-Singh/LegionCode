import { Sandbox } from "@cloudflare/sandbox";
import { IPlugin, PluginResult, LogCallback, PluginExecutionContext } from "../interfaces/types";
import { z } from "zod";
import { PythonTool } from "../schemas/python";
import { normalizeRunId } from "./security/PathGuard";
import { resolveScopedWorkspaceRoot } from "./security/WorkspaceScope";
import { runSafeCommand } from "./security/SafeCommand";
import {
  readToolboxCommandContext,
  withToolboxCommandContext,
} from "./security/ToolboxCommandContext";

const PYTHON_ALLOWED_COMMANDS = ["python3"] as const;
const REQUIREMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-[\],<>=!~]*$/;
const MANAGED_ENVIRONMENT_PATTERN = /externally-managed-environment/i;

const PythonPayloadSchema = z.object({
  code: z.string().min(1),
  requirements: z.array(z.string().min(1)).max(64).optional(),
  runId: z.string().optional(),
});

export class PythonPlugin implements IPlugin {
  name = "python";
  tools = [PythonTool];

  async execute(
    sandbox: Sandbox,
    payload: unknown,
    onLog?: LogCallback,
    context?: PluginExecutionContext,
  ): Promise<PluginResult> {
    try {
      const toolboxContext = readToolboxCommandContext(payload);
      const parsed = PythonPayloadSchema.parse(payload);
      const runId = normalizeRunId(parsed.runId ?? toolboxContext.runId);
      const workspaceRoot = resolveScopedWorkspaceRoot(context, runId);
      const requirements = normalizeRequirements(parsed.requirements ?? []);

      if (onLog) onLog("[System] Initializing Python environment...");

      await runSafeCommand(
        sandbox,
        withToolboxCommandContext(
          { command: "mkdir", args: ["-p", workspaceRoot], runId },
          toolboxContext,
          "python.prepare_workspace",
        ),
        ["mkdir"],
      );

      if (requirements.length > 0) {
        const installResult = await this.installRequirements(
          sandbox,
          workspaceRoot,
          requirements,
          toolboxContext,
          runId,
          onLog,
        );
        if (installResult) {
          return installResult;
        }
      }

      await sandbox.writeFile(`${workspaceRoot}/main.py`, parsed.code);

      if (onLog) onLog("[System] Executing script...");
      const result = await runSafeCommand(
        sandbox,
        withToolboxCommandContext(
          { command: "python3", args: ["main.py"], cwd: workspaceRoot, runId },
          toolboxContext,
          "python.execute",
        ),
        PYTHON_ALLOWED_COMMANDS,
      );

      if (onLog) {
        if (result.stdout) onLog(result.stdout);
        if (result.stderr) onLog(`[stderr] ${result.stderr}`);
      }

      return {
        success: result.exitCode === 0,
        output: result.stdout,
        logs: splitLogLines(result.stderr),
        error: result.exitCode !== 0 ? "Execution failed" : undefined,
      };
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : "Python plugin execution failed";
      return { success: false, error: message };
    }
  }

  private async installRequirements(
    sandbox: Sandbox,
    workspaceRoot: string,
    requirements: string[],
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
    onLog?: LogCallback,
  ): Promise<PluginResult | null> {
    if (onLog) {
      onLog(`[System] Installing dependencies: ${requirements.join(", ")}...`);
    }

    let install = await runSafeCommand(
      sandbox,
      withToolboxCommandContext(
        {
          command: "python3",
          args: ["-m", "pip", "install", ...requirements],
          cwd: workspaceRoot,
          runId,
        },
        toolboxContext,
        "python.install_requirements",
      ),
      PYTHON_ALLOWED_COMMANDS,
    );

    if (
      install.exitCode !== 0 &&
      MANAGED_ENVIRONMENT_PATTERN.test(`${install.stderr}\n${install.stdout}`)
    ) {
      if (onLog) {
        onLog(
          "[System] Managed environment detected. Retrying with --break-system-packages...",
        );
      }
      install = await runSafeCommand(
        sandbox,
        withToolboxCommandContext(
          {
            command: "python3",
            args: [
              "-m",
              "pip",
              "install",
              ...requirements,
              "--break-system-packages",
            ],
            cwd: workspaceRoot,
            runId,
          },
          toolboxContext,
          "python.install_requirements",
        ),
        PYTHON_ALLOWED_COMMANDS,
      );
    }

    if (onLog) {
      if (install.stdout) onLog(install.stdout);
      if (install.stderr) onLog(install.stderr);
    }

    if (install.exitCode === 0) {
      return null;
    }

    return {
      success: false,
      output: install.stdout,
      logs: splitLogLines(install.stderr),
      error: "Dependency installation failed.",
    };
  }
}

function normalizeRequirements(requirements: string[]): string[] {
  return requirements.map(validateRequirementSpecifier);
}

function validateRequirementSpecifier(requirement: string): string {
  const trimmed = requirement.trim();
  if (!trimmed) {
    throw new Error("Python requirement cannot be empty");
  }
  if (!REQUIREMENT_PATTERN.test(trimmed)) {
    throw new Error(`Invalid Python requirement: ${trimmed}`);
  }
  return trimmed;
}

function splitLogLines(value: string): string[] {
  if (!value) {
    return [];
  }
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
