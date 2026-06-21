import path from "node:path";
import type { Sandbox } from "@cloudflare/sandbox";
import type { PluginResult } from "../../interfaces/types";
import { runSafeCommand } from "../security/SafeCommand";
import { withToolboxCommandContext } from "../security/ToolboxCommandContext";
import {
  WorkspacePathResolver,
  type WorkspaceToolContext,
} from "./WorkspacePathResolver";
import { truncateUtf8 } from "./Utf8Text";

const MAX_LANGUAGE_OUTPUT_BYTES = 24_000;
const LANGUAGE_TOOL_TIMEOUT_MS = 30_000;
const PRETTIER_EXTENSIONS = new Set([
  ".css",
  ".graphql",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mdx",
  ".scss",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const TYPESCRIPT_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]);

export class LanguageToolService {
  private readonly pathResolver = new WorkspacePathResolver();

  async formatFile(
    context: WorkspaceToolContext,
    inputPath: string,
  ): Promise<PluginResult> {
    const targetPath = await this.resolveSupportedPath(
      context,
      inputPath,
      PRETTIER_EXTENSIONS,
      "formatter",
    );
    const before = await readTextFile(context.sandbox, targetPath);
    const result = await runLanguageCommand(
      context,
      ["exec", "prettier", "--write", "--", targetPath],
      "filesystem.format_file",
    );
    if (result.exitCode !== 0) {
      return { success: false, error: result.stderr || "Formatter failed" };
    }
    const after = await readTextFile(context.sandbox, targetPath);
    const output = capLanguageOutput(result.stdout || `Formatted ${inputPath}`);
    return {
      success: true,
      output: output.value,
      metadata: {
        path: inputPath,
        formatter: "prettier",
        changed: before !== after,
      },
      truncated: output.truncated,
    };
  }

  async diagnostics(
    context: WorkspaceToolContext,
    inputPath: string,
  ): Promise<PluginResult> {
    await this.resolveSupportedPath(
      context,
      inputPath,
      TYPESCRIPT_EXTENSIONS,
      "language diagnostics",
    );
    const result = await runLanguageCommand(
      context,
      [
        "exec",
        "tsc",
        "--noEmit",
        "--pretty",
        "false",
        "--incremental",
        "false",
      ],
      "filesystem.language_diagnostics",
    );
    if (![0, 2].includes(result.exitCode)) {
      return {
        success: false,
        error: result.stderr || "TypeScript diagnostics failed",
      };
    }
    return buildDiagnosticsResult(inputPath, result.stdout, result.stderr);
  }

  private async resolveSupportedPath(
    context: WorkspaceToolContext,
    inputPath: string,
    extensions: ReadonlySet<string>,
    toolName: string,
  ): Promise<string> {
    const extension = path.posix.extname(inputPath).toLowerCase();
    if (!extensions.has(extension)) {
      throw new Error(
        `${toolName} does not support ${extension || "this file type"}`,
      );
    }
    return this.pathResolver.resolve(
      context,
      inputPath,
      `filesystem.${toolName.replaceAll(" ", "_")}.resolve_path`,
    );
  }
}

async function runLanguageCommand(
  context: WorkspaceToolContext,
  args: string[],
  operation: string,
) {
  return runSafeCommand(
    context.sandbox,
    withToolboxCommandContext(
      {
        command: "pnpm",
        args,
        cwd: context.workspaceRoot,
        runId: context.runId,
        timeoutMs: LANGUAGE_TOOL_TIMEOUT_MS,
      },
      context.toolboxContext,
      operation,
    ),
    ["pnpm"],
  );
}

async function readTextFile(
  sandbox: Sandbox,
  targetPath: string,
): Promise<string> {
  const result = await sandbox.readFile(targetPath, { encoding: "utf-8" });
  if (!result.success || typeof result.content !== "string") {
    throw new Error("Unable to read language-tool target");
  }
  return result.content;
}

function buildDiagnosticsResult(
  inputPath: string,
  stdout: string,
  stderr: string,
): PluginResult {
  const combined = [stdout, stderr].filter(Boolean).join("\n");
  const output = capLanguageOutput(
    combined || "No TypeScript diagnostics found",
  );
  return {
    success: true,
    output: output.value,
    metadata: {
      path: inputPath,
      languageService: "typescript",
      diagnosticCount: countDiagnostics(combined),
    },
    truncated: output.truncated,
  };
}

function countDiagnostics(output: string): number {
  return output.split("\n").filter((line) => /error TS\d+:/u.test(line)).length;
}

function capLanguageOutput(value: string): {
  value: string;
  truncated: boolean;
} {
  return truncateUtf8(
    value,
    MAX_LANGUAGE_OUTPUT_BYTES,
    "\n[output truncated]",
  );
}
