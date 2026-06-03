import type { Sandbox } from "@cloudflare/sandbox";
import type { PluginResult } from "../../interfaces/types";
import {
  type ToolboxCommandContext,
  withToolboxCommandContext,
} from "../security/ToolboxCommandContext";
import { runSafeCommand } from "../security/SafeCommand";
import { validateRepoRelativePath } from "../security/PathGuard";

const DEFAULT_MAX_RESULTS = 50;
const MAX_RESULTS = 200;
const MAX_LINE_LENGTH = 500;
const MAX_RG_STDOUT_BYTES = 120_000;
const RG_TIMEOUT_MS = 5_000;
const GIT_EXCLUDE_GLOB = "!.git/**";

export interface FilesInput {
  path?: string;
  glob?: string;
  maxResults?: number;
}

export interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  maxResults?: number;
  caseSensitive?: boolean;
}

interface GrepRow {
  path: string;
  line: number;
  text: string;
  matchCount: number;
}

interface TreeRow {
  path: string;
  depth: number;
  kind: "file" | "directory";
}

interface CommandContext {
  sandbox: Sandbox;
  workspaceRoot: string;
  toolboxContext: ToolboxCommandContext;
  runId: string;
}

interface RipgrepJsonMatch {
  type?: string;
  data?: {
    path?: { text?: string };
    line_number?: number;
    lines?: { text?: string };
    submatches?: unknown[];
  };
}

export class RipgrepService {
  async files(
    context: CommandContext,
    input: FilesInput,
  ): Promise<PluginResult> {
    const maxResults = clampMaxResults(input.maxResults);
    const stdout = capRipgrepStdout(await this.runFilesCommand(context, input));
    const paths = sortUnique(stdout.output.split("\n").filter(Boolean));
    return buildPathResult("Files", paths, maxResults, stdout.truncated);
  }

  async glob(
    context: CommandContext,
    input: FilesInput,
  ): Promise<PluginResult> {
    return this.files(context, input);
  }

  async tree(
    context: CommandContext,
    input: FilesInput,
  ): Promise<PluginResult> {
    const maxResults = clampMaxResults(input.maxResults);
    const stdout = capRipgrepStdout(await this.runFilesCommand(context, input));
    const rows = buildTreeRows(
      sortUnique(stdout.output.split("\n").filter(Boolean)),
    );
    return buildTreeResult(rows, maxResults, stdout.truncated);
  }

  async grep(context: CommandContext, input: GrepInput): Promise<PluginResult> {
    const maxResults = clampMaxResults(input.maxResults);
    const result = await this.runGrepCommand(context, input);
    if (result.exitCode === 2) {
      return buildInvalidRegexResult(result.stderr);
    }
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      return { success: false, error: result.stderr || "grep failed" };
    }
    const stdout = capRipgrepStdout(result.stdout);
    return buildGrepResult(
      parseGrepRows(stdout.output),
      maxResults,
      stdout.truncated,
    );
  }

  private async runFilesCommand(
    context: CommandContext,
    input: FilesInput,
  ): Promise<string> {
    const result = await runSafeCommand(
      context.sandbox,
      withToolboxCommandContext(
        {
          command: "rg",
          args: buildFilesArgs(input),
          cwd: context.workspaceRoot,
          runId: context.runId,
          timeoutMs: RG_TIMEOUT_MS,
        },
        context.toolboxContext,
        "filesystem.ripgrep_files",
      ),
      ["rg"],
    );
    if (result.exitCode === 1 && result.stderr.trim().length === 0) {
      return "";
    }
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || "ripgrep file listing failed");
    }
    return result.stdout;
  }

  private async runGrepCommand(context: CommandContext, input: GrepInput) {
    return runSafeCommand(
      context.sandbox,
      withToolboxCommandContext(
        {
          command: "rg",
          args: buildGrepArgs(input),
          cwd: context.workspaceRoot,
          runId: context.runId,
          timeoutMs: RG_TIMEOUT_MS,
        },
        context.toolboxContext,
        "filesystem.ripgrep_grep",
      ),
      ["rg"],
    );
  }
}

function buildFilesArgs(input: FilesInput): string[] {
  const args = ["--files", "--sort", "path", "--glob", GIT_EXCLUDE_GLOB];
  if (input.glob) {
    args.push("--glob", validateSearchPattern(input.glob));
  }
  args.push(resolveSearchPath(input.path));
  return args;
}

function buildGrepArgs(input: GrepInput): string[] {
  const args = [
    "--json",
    "--line-number",
    "--with-filename",
    "--color",
    "never",
    "--sort",
    "path",
    "--glob",
    GIT_EXCLUDE_GLOB,
    "--max-columns",
    String(MAX_LINE_LENGTH),
    "--regexp",
    validateSearchPattern(input.pattern),
  ];
  if (!input.caseSensitive) {
    args.unshift("--ignore-case");
  }
  if (input.glob) {
    args.push("--glob", validateSearchPattern(input.glob));
  }
  args.push(resolveSearchPath(input.path));
  return args;
}

function parseGrepRows(stdout: string): GrepRow[] {
  const rows: GrepRow[] = [];
  for (const line of stdout.split("\n")) {
    const row = parseGrepJsonLine(line);
    if (row) {
      rows.push(row);
    }
  }
  return rows;
}

function parseGrepJsonLine(line: string): GrepRow | null {
  if (!line.trim()) {
    return null;
  }
  const parsed = parseJson(line);
  if (parsed?.type !== "match" || !parsed.data) {
    return null;
  }
  const filePath = parsed.data.path?.text;
  const lineNumber = parsed.data.line_number;
  const text = parsed.data.lines?.text;
  if (!filePath || typeof lineNumber !== "number" || typeof text !== "string") {
    return null;
  }
  return {
    path: filePath,
    line: lineNumber,
    text: truncateLine(text.replace(/\n$/, "")),
    matchCount: Math.max(parsed.data.submatches?.length ?? 0, 1),
  };
}

function parseJson(line: string): RipgrepJsonMatch | null {
  try {
    return JSON.parse(line) as RipgrepJsonMatch;
  } catch {
    return null;
  }
}

function buildPathResult(
  title: string,
  paths: string[],
  maxResults: number,
  stdoutTruncated: boolean,
): PluginResult {
  const limited = paths.slice(0, maxResults);
  const truncated = stdoutTruncated || paths.length > limited.length;
  return {
    success: true,
    output: limited.join("\n"),
    metadata: {
      title,
      paths: limited,
      total: paths.length,
      returned: limited.length,
      outputByteCap: MAX_RG_STDOUT_BYTES,
      stdoutTruncated,
      narrowHint: buildNarrowHint(truncated),
    },
    truncated,
  };
}

function buildTreeResult(
  rows: TreeRow[],
  maxResults: number,
  stdoutTruncated: boolean,
): PluginResult {
  const limited = rows.slice(0, maxResults);
  const truncated = stdoutTruncated || rows.length > limited.length;
  return {
    success: true,
    output: limited.map(formatTreeRow).join("\n"),
    metadata: {
      rows: limited,
      total: rows.length,
      returned: limited.length,
      outputByteCap: MAX_RG_STDOUT_BYTES,
      stdoutTruncated,
      narrowHint: buildNarrowHint(truncated),
    },
    truncated,
  };
}

function buildGrepResult(
  rows: GrepRow[],
  maxResults: number,
  stdoutTruncated: boolean,
): PluginResult {
  const limited = rows.slice(0, maxResults);
  const truncated = stdoutTruncated || rows.length > limited.length;
  return {
    success: true,
    output: limited.map(formatGrepRow).join("\n"),
    metadata: {
      rows: limited,
      totalRows: rows.length,
      totalMatches: rows.reduce((total, row) => total + row.matchCount, 0),
      returned: limited.length,
      outputByteCap: MAX_RG_STDOUT_BYTES,
      stdoutTruncated,
      narrowHint: buildNarrowHint(truncated),
    },
    truncated,
  };
}

function buildInvalidRegexResult(stderr: string): PluginResult {
  return {
    success: false,
    error: `Invalid grep regex: ${stderr.trim() || "pattern failed to compile"}`,
    metadata: { reason: "invalid_regex" },
    truncated: false,
  };
}

function buildTreeRows(paths: string[]): TreeRow[] {
  const rows = new Map<string, TreeRow>();
  for (const filePath of paths) {
    addDirectoryRows(rows, filePath);
    rows.set(filePath, {
      path: filePath,
      depth: filePath.split("/").length - 1,
      kind: "file",
    });
  }
  return [...rows.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

function addDirectoryRows(rows: Map<string, TreeRow>, filePath: string): void {
  const parts = filePath.split("/");
  for (let index = 1; index < parts.length; index += 1) {
    const path = parts.slice(0, index).join("/");
    rows.set(path, { path, depth: index - 1, kind: "directory" });
  }
}

function formatGrepRow(row: GrepRow): string {
  return `${row.path}:${row.line}: ${row.text}`;
}

function formatTreeRow(row: TreeRow): string {
  return `${"  ".repeat(row.depth)}${row.kind === "directory" ? "> " : "- "}${row.path}`;
}

function resolveSearchPath(inputPath: string | undefined): string {
  return inputPath ? validateRepoRelativePath(inputPath) : ".";
}

function validateSearchPattern(pattern: string): string {
  if (/[\0\r\n]/.test(pattern)) {
    throw new Error("Invalid search pattern: contains illegal characters");
  }
  return pattern;
}

function clampMaxResults(value: number | undefined): number {
  if (!value) {
    return DEFAULT_MAX_RESULTS;
  }
  return Math.min(Math.max(value, 1), MAX_RESULTS);
}

function sortUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function capRipgrepStdout(stdout: string): {
  output: string;
  truncated: boolean;
} {
  if (stdout.length <= MAX_RG_STDOUT_BYTES) {
    return { output: stdout, truncated: false };
  }
  return {
    output: stdout.slice(0, MAX_RG_STDOUT_BYTES),
    truncated: true,
  };
}

function truncateLine(line: string): string {
  if (line.length <= MAX_LINE_LENGTH) {
    return line;
  }
  return `${line.slice(0, MAX_LINE_LENGTH)} [line truncated]`;
}

function buildNarrowHint(truncated: boolean): string | undefined {
  return truncated
    ? "Narrow path/glob or lower result scope to continue."
    : undefined;
}
