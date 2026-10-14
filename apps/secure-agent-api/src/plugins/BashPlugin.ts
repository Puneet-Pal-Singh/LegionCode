import { Sandbox } from "@cloudflare/sandbox";
import { z } from "zod";
import { BashTool } from "../schemas/bash";
import {
  IPlugin,
  LogCallback,
  PluginExecutionContext,
  PluginResult,
} from "../interfaces/types";
import {
  normalizeRunId,
  resolveWorkspacePath,
  validateRepoRelativePath,
} from "./security/PathGuard";
import { resolveScopedWorkspaceRoot } from "./security/WorkspaceScope";
import { runSafeCommand } from "./security/SafeCommand";
import {
  readToolboxCommandContext,
  withToolboxCommandContext,
} from "./security/ToolboxCommandContext";

const BASH_ALLOWED_COMMANDS = ["bash"] as const;
const MAX_BASH_COMMAND_LENGTH = 4_000;
const LOG_CHUNK_SIZE = 4_096;
const PNPM_COMMAND_PREFIX = /^\s*pnpm(?:\s|$)/i;

const BashPayloadSchema = z.object({
  action: z.literal("run"),
  runId: z.string().optional(),
  command: z.string().min(1).max(MAX_BASH_COMMAND_LENGTH),
  cwd: z.string().min(1).optional(),
});

export class BashPlugin implements IPlugin {
  name = "bash";
  tools = [BashTool];

  async execute(
    sandbox: Sandbox,
    payload: unknown,
    onLog?: LogCallback,
    context?: PluginExecutionContext,
  ): Promise<PluginResult> {
    try {
      const toolboxContext = readToolboxCommandContext(payload);
      const parsed = BashPayloadSchema.parse(payload);
      validateBashCommand(parsed.command);

      const runId = normalizeRunId(parsed.runId ?? toolboxContext.runId);
      const workspaceRoot = resolveScopedWorkspaceRoot(context, runId);
      const cwd = resolveBashCwd(workspaceRoot, parsed.cwd);

      await runSafeCommand(
        sandbox,
        withToolboxCommandContext(
          { command: "mkdir", args: ["-p", workspaceRoot], runId },
          toolboxContext,
          "bash.prepare_workspace",
        ),
        ["mkdir"],
      );

      onLog?.({
        message: "Bash command accepted for execution.",
        source: "stdout",
      });

      const runtimeCommand = buildRuntimeBashCommand(parsed.command);
      const result = await runSafeCommand(
        sandbox,
        withToolboxCommandContext(
          {
            command: "bash",
            args: ["-lc", runtimeCommand],
            cwd,
            runId,
          },
          toolboxContext,
          "bash.run",
        ),
        BASH_ALLOWED_COMMANDS,
      );

      emitCommandLogs(onLog, result.stdout, "stdout");
      emitCommandLogs(onLog, result.stderr, "stderr");

      return {
        success: result.exitCode === 0,
        output: result.stdout,
        error:
          result.exitCode === 0 ? undefined : result.stderr || "Command failed",
      };
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Bash plugin execution failed";
      if (error instanceof BashValidationError) {
        return {
          success: false,
          error: error.reason,
          failure: {
            kind: "pre_execution_rejection",
            ruleId: error.ruleId,
            reason: error.reason,
            correctionGuidance: error.correctionGuidance,
            executionStarted: false,
          },
        };
      }
      return {
        success: false,
        error: message,
      };
    }
  }
}

function resolveBashCwd(
  workspaceRoot: string,
  cwd: string | undefined,
): string {
  if (!cwd || cwd.trim() === "." || cwd.trim() === "./") {
    return workspaceRoot;
  }

  const normalized = validateRepoRelativePath(cwd);
  return resolveWorkspacePath(workspaceRoot, normalized);
}

function validateBashCommand(command: string): void {
  const normalized = command.trim();
  if (!normalized) {
    throw new BashValidationError(
      "bash.empty_command",
      "Bash command cannot be empty.",
      "Provide a non-empty command within the approved workspace.",
    );
  }
  if (/[\0\r\n]/.test(command)) {
    throw new BashValidationError(
      "bash.multiline_or_control_character",
      "Multiline and control-character command arguments are not allowed.",
      "Use a single-line command or an approved typed tool.",
    );
  }

  const executableText = maskSingleQuotedText(normalized);
  const dequotedText = flattenShellQuotes(normalized);
  const dangerousPatterns = [
    /(^|[;&|]\s*)rm\s+/i,
    /;\s*killall/i,
    /\|\s*bash/i,
    /sudo\s/i,
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(dequotedText)) {
      throw new BashValidationError(
        "bash.restricted_command_pattern",
        "This command matches a restricted shell pattern.",
        "Use a direct command or an approved typed tool; do not embed shell substitutions or destructive operations.",
      );
    }
  }
  if (
    /\$\(|`/.test(executableText) ||
    (hasNestedShellOrEval(normalized) && /\$\(|`/.test(normalized))
  ) {
    throw new BashValidationError(
      "bash.command_substitution",
      "Shell command substitution is not allowed in this command.",
      "Use a direct command or an approved typed tool; do not embed shell substitutions or destructive operations.",
    );
  }
}

function hasNestedShellOrEval(command: string): boolean {
  const flattened = flattenShellQuotes(command);
  return (
    /(?:^|[\s;&|()])(?:[^\s;&|()]+\/)?(?:bash|sh|dash|zsh|ksh|fish|eval|source)(?=$|[\s;&|()])/i.test(
      flattened,
    ) || /(?:^|\s)(?:-[a-z]*c|--command(?:=|\s|$))/i.test(flattened)
  );
}

function maskSingleQuotedText(command: string): string {
  let quote: "single" | "double" | null = null;
  let escaped = false;
  let masked = "";
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (
      quote === null &&
      char === "#" &&
      (index === 0 || /[\s;&|()]/.test(command[index - 1]!))
    ) {
      masked += " ".repeat(command.length - index);
      break;
    }
    if (quote === "single") {
      masked += " ";
      if (char === "'") quote = null;
      continue;
    }
    if (escaped) {
      masked += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      masked += char;
      escaped = true;
      continue;
    }
    if (quote === "double") {
      masked += char;
      if (char === '"') quote = null;
      continue;
    }
    if (char === "'") {
      masked += " ";
      quote = "single";
    } else {
      masked += char;
      if (char === '"') quote = "double";
    }
  }
  return masked;
}

function flattenShellQuotes(command: string): string {
  let quote: "single" | "double" | null = null;
  let escaped = false;
  let flattened = "";
  for (const char of command) {
    if (escaped) {
      flattened += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "single") {
      escaped = true;
      continue;
    }
    if (quote === "single") {
      if (char === "'") quote = null;
      else flattened += char;
      continue;
    }
    if (quote === "double") {
      if (char === '"') quote = null;
      else flattened += char;
      continue;
    }
    if (char === "'") quote = "single";
    else if (char === '"') quote = "double";
    else flattened += char;
  }
  return flattened;
}

class BashValidationError extends Error {
  constructor(
    readonly ruleId: string,
    readonly reason: string,
    readonly correctionGuidance: string,
  ) {
    super(reason);
  }
}

function buildRuntimeBashCommand(command: string): string {
  if (!PNPM_COMMAND_PREFIX.test(command)) {
    return command;
  }

  const pnpmArgs = command
    .trim()
    .replace(/^pnpm\b/i, "")
    .trim();
  const pnpmInvocation = pnpmArgs.length > 0 ? `pnpm ${pnpmArgs}` : "pnpm";
  const corepackInvocation =
    pnpmArgs.length > 0 ? `corepack pnpm ${pnpmArgs}` : "corepack pnpm";
  const npmFallbackInvocation = buildNpmFallbackInvocation(pnpmArgs);
  const finalFallbackInvocation =
    npmFallbackInvocation ?? buildPnpmUnavailableFallbackInvocation(pnpmArgs);

  return [
    'export PATH="$PATH:/usr/local/bin:/usr/bin:/bin:/home/sandbox/.local/share/pnpm";',
    `if command -v pnpm >/dev/null 2>&1; then ${pnpmInvocation};`,
    `elif command -v corepack >/dev/null 2>&1; then ${corepackInvocation};`,
    `else ${finalFallbackInvocation};`,
    "fi",
  ].join(" ");
}

function buildNpmFallbackInvocation(pnpmArgs: string): string | null {
  const trimmedArgs = pnpmArgs.trim();
  if (!trimmedArgs) {
    return null;
  }

  const runScriptMatch = trimmedArgs.match(/^run\s+(.+)$/i);
  if (runScriptMatch?.[1]) {
    return `npm run ${runScriptMatch[1]}`;
  }

  const testMatch = trimmedArgs.match(/^test(?:\s+(.+))?$/i);
  if (testMatch) {
    return testMatch[1] ? `npm test ${testMatch[1]}` : "npm test";
  }

  const installMatch = trimmedArgs.match(/^install(?:\s+(.+))?$/i);
  if (installMatch) {
    return installMatch[1] ? `npm install ${installMatch[1]}` : "npm install";
  }

  return null;
}

function buildPnpmUnavailableFallbackInvocation(pnpmArgs: string): string {
  const requestedCommand =
    pnpmArgs.trim().length > 0 ? `pnpm ${pnpmArgs.trim()}` : "pnpm";
  const quotedRequestedCommand = quoteShellLiteral(
    `pnpm is unavailable in this runtime and no npm fallback mapping exists for: ${requestedCommand}`,
  );

  return `printf '%s\\n' ${quotedRequestedCommand} >&2; exit 127`;
}

function quoteShellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function emitCommandLogs(
  onLog: LogCallback | undefined,
  value: string,
  source: "stdout" | "stderr",
): void {
  if (!onLog || !value) {
    return;
  }

  for (let index = 0; index < value.length; index += LOG_CHUNK_SIZE) {
    onLog({
      message: value.slice(index, index + LOG_CHUNK_SIZE),
      source,
    });
  }
}
