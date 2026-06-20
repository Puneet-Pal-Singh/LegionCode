// apps/secure-agent-api/src/plugins/FileSystemPlugin.ts
import { Sandbox } from "@cloudflare/sandbox";
import { IPlugin, PluginResult, LogCallback } from "../interfaces/types";
import { FileSystemTools } from "../schemas/filesystem";
import { z } from "zod";
import {
  getWorkspaceRoot,
  normalizeRunId,
  resolveWorkspacePath,
} from "./security/PathGuard";
import { runSafeCommand } from "./security/SafeCommand";
import {
  readToolboxCommandContext,
  withToolboxCommandContext,
} from "./security/ToolboxCommandContext";
import { RipgrepService } from "./filesystem/RipgrepService";
import { WorkspaceEditService } from "./filesystem/WorkspaceEditService";
import { LanguageToolService } from "./filesystem/LanguageToolService";
import {
  truncateUtf8,
  utf8ByteLength,
} from "./filesystem/Utf8Text";

const DEFAULT_READ_LIMIT = 200;
const MAX_READ_LIMIT = 1_000;
const MAX_READ_LINE_LENGTH = 500;
const MAX_READ_OUTPUT_BYTES = 24_000;
const MAX_READ_FILE_BYTES = 1_048_576;
const MAX_WRITE_CONTENT_BYTES = 200_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const BoundedWriteContentSchema = z
  .string()
  .refine((value) => utf8ByteLength(value) <= MAX_WRITE_CONTENT_BYTES, {
    message: `Content exceeds ${MAX_WRITE_CONTENT_BYTES} UTF-8 bytes`,
  });

const ExactEditSchema = z.object({
  path: z.string().min(1),
  oldText: BoundedWriteContentSchema.refine((value) => value.length > 0, {
    message: "oldText must not be empty",
  }),
  newText: BoundedWriteContentSchema,
  replaceAll: z.boolean().optional(),
  expectedReplacements: z.number().int().min(1).max(10_000).optional(),
  expectedSha256: z.string().regex(SHA256_PATTERN).optional(),
});

const FileSystemPayloadSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("list_files"),
    path: z.string().optional(),
    runId: z.string().optional(),
  }),
  z.object({
    action: z.literal("read_file"),
    path: z.string().min(1),
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(MAX_READ_LIMIT).optional(),
    runId: z.string().optional(),
  }),
  z.object({
    action: z.literal("files"),
    path: z.string().optional(),
    glob: z.string().optional(),
    maxResults: z.number().int().min(1).max(200).optional(),
    runId: z.string().optional(),
  }),
  z.object({
    action: z.literal("tree"),
    path: z.string().optional(),
    glob: z.string().optional(),
    maxResults: z.number().int().min(1).max(200).optional(),
    runId: z.string().optional(),
  }),
  z.object({
    action: z.literal("glob"),
    pattern: z.string().min(1),
    path: z.string().optional(),
    maxResults: z.number().int().min(1).max(200).optional(),
    runId: z.string().optional(),
  }),
  z.object({
    action: z.literal("grep"),
    pattern: z.string().min(1),
    path: z.string().optional(),
    glob: z.string().optional(),
    maxResults: z.number().int().min(1).max(200).optional(),
    caseSensitive: z.boolean().optional(),
    runId: z.string().optional(),
  }),
  z.object({
    action: z.literal("write_file"),
    path: z.string().min(1),
    content: BoundedWriteContentSchema,
    expectedSha256: z.string().regex(SHA256_PATTERN).optional(),
    runId: z.string().optional(),
  }),
  ExactEditSchema.extend({
    action: z.literal("edit_file"),
    runId: z.string().optional(),
  }),
  z.object({
    action: z.literal("multi_edit"),
    edits: z.array(ExactEditSchema).min(1).max(20),
    runId: z.string().optional(),
  }),
  z.object({
    action: z.literal("format_file"),
    path: z.string().min(1),
    runId: z.string().optional(),
  }),
  z.object({
    action: z.literal("language_diagnostics"),
    path: z.string().min(1),
    runId: z.string().optional(),
  }),
  z.object({
    action: z.literal("make_dir"),
    path: z.string().min(1),
    runId: z.string().optional(),
  }),
]);

type FileSystemPayload = z.infer<typeof FileSystemPayloadSchema>;

export class FileSystemPlugin implements IPlugin {
  name = "filesystem";
  tools = FileSystemTools;
  private readonly ripgrepService = new RipgrepService();
  private readonly workspaceEditService = new WorkspaceEditService();
  private readonly languageToolService = new LanguageToolService();

  async execute(
    sandbox: Sandbox,
    payload: unknown,
    _onLog?: LogCallback,
  ): Promise<PluginResult> {
    try {
      const toolboxContext = readToolboxCommandContext(payload);
      const parsedPayload = FileSystemPayloadSchema.parse(payload);
      const runId = normalizeRunId(parsedPayload.runId ?? toolboxContext.runId);
      const workspaceRoot = getWorkspaceRoot(runId);

      await runSafeCommand(
        sandbox,
        withToolboxCommandContext(
          { command: "mkdir", args: ["-p", workspaceRoot], runId },
          toolboxContext,
          "filesystem.prepare_workspace",
        ),
        ["mkdir"],
      );

      if (parsedPayload.action === "list_files") {
        return await this.listFiles(
          sandbox,
          workspaceRoot,
          parsedPayload,
          toolboxContext,
          runId,
        );
      }
      if (parsedPayload.action === "read_file") {
        return await this.readFile(
          sandbox,
          workspaceRoot,
          parsedPayload,
          toolboxContext,
          runId,
        );
      }
      if (parsedPayload.action === "files") {
        return await this.ripgrepService.files(
          { sandbox, workspaceRoot, toolboxContext, runId },
          parsedPayload,
        );
      }
      if (parsedPayload.action === "tree") {
        return await this.ripgrepService.tree(
          { sandbox, workspaceRoot, toolboxContext, runId },
          parsedPayload,
        );
      }
      if (parsedPayload.action === "glob") {
        return await this.ripgrepService.glob(
          { sandbox, workspaceRoot, toolboxContext, runId },
          {
            path: parsedPayload.path,
            glob: parsedPayload.pattern,
            maxResults: parsedPayload.maxResults,
          },
        );
      }
      if (parsedPayload.action === "grep") {
        return await this.ripgrepService.grep(
          { sandbox, workspaceRoot, toolboxContext, runId },
          parsedPayload,
        );
      }
      if (parsedPayload.action === "write_file") {
        return await this.workspaceEditService.write(
          { sandbox, workspaceRoot, toolboxContext, runId },
          parsedPayload,
        );
      }
      if (parsedPayload.action === "edit_file") {
        return await this.workspaceEditService.edit(
          { sandbox, workspaceRoot, toolboxContext, runId },
          parsedPayload,
        );
      }
      if (parsedPayload.action === "multi_edit") {
        return await this.workspaceEditService.multiEdit(
          { sandbox, workspaceRoot, toolboxContext, runId },
          parsedPayload.edits,
        );
      }
      if (parsedPayload.action === "format_file") {
        return await this.languageToolService.formatFile(
          { sandbox, workspaceRoot, toolboxContext, runId },
          parsedPayload.path,
        );
      }
      if (parsedPayload.action === "language_diagnostics") {
        return await this.languageToolService.diagnostics(
          { sandbox, workspaceRoot, toolboxContext, runId },
          parsedPayload.path,
        );
      }
      return await this.makeDirectory(
        sandbox,
        workspaceRoot,
        parsedPayload,
        toolboxContext,
        runId,
      );
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Filesystem operation failed";
      return { success: false, error: message };
    }
  }

  private async listFiles(
    sandbox: Sandbox,
    workspaceRoot: string,
    payload: Extract<FileSystemPayload, { action: "list_files" }>,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
  ): Promise<PluginResult> {
    const targetDir = resolveWorkspacePath(workspaceRoot, payload.path ?? ".");
    const result = await runSafeCommand(
      sandbox,
      withToolboxCommandContext(
        { command: "ls", args: ["-1p", targetDir], runId },
        toolboxContext,
        "filesystem.list_files",
      ),
      ["ls"],
    );

    if (result.exitCode !== 0) {
      return { success: false, error: result.stderr || "Directory not found" };
    }

    const files = result.stdout
      .trim()
      .split("\n")
      .filter((entry) => entry.length > 0);
    const totalFiles = files.length;
    if (totalFiles > 20) {
      const limited = files.slice(0, 20).join("\n");
      return {
        success: true,
        output: `${limited}\n\n... and ${totalFiles - 20} more files (Total: ${totalFiles})`,
      };
    }

    return { success: true, output: result.stdout };
  }

  private async readFile(
    sandbox: Sandbox,
    workspaceRoot: string,
    payload: Extract<FileSystemPayload, { action: "read_file" }>,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
  ): Promise<PluginResult> {
    const targetPath = resolveWorkspacePath(workspaceRoot, payload.path);
    let totalBytes: number | undefined;
    if (shouldGuardUnconditionalRead(payload)) {
      const statResult = await runSafeCommand(
        sandbox,
        withToolboxCommandContext(
          { command: "stat", args: ["-c", "%s", targetPath], runId },
          toolboxContext,
          "filesystem.read_file_stat",
        ),
        ["stat"],
      );
      if (statResult.exitCode !== 0) {
        return {
          success: false,
          error: statResult.stderr || "Unable to stat file",
        };
      }
      const parsedBytes = Number(statResult.stdout.trim());
      totalBytes = Number.isFinite(parsedBytes) ? parsedBytes : undefined;
      if (totalBytes !== undefined && totalBytes > MAX_READ_FILE_BYTES) {
        return {
          success: false,
          error: `File too large to read unconditionally (${totalBytes} bytes > ${MAX_READ_FILE_BYTES}). Pass offset/limit to stream a window.`,
          metadata: {
            path: payload.path,
            totalBytes,
            maxReadBytes: MAX_READ_FILE_BYTES,
          },
        };
      }
    }

    const fileTypeResult = await runSafeCommand(
      sandbox,
      withToolboxCommandContext(
        {
          command: "file",
          args: ["-b", "--mime-type", targetPath],
          runId,
        },
        toolboxContext,
        "filesystem.read_file_type",
      ),
      ["file"],
    );
    if (fileTypeResult.exitCode !== 0) {
      return {
        success: false,
        error: fileTypeResult.stderr || "Unable to read file type",
      };
    }

    const mimeType = fileTypeResult.stdout.trim().toLowerCase();
    if (isBinaryMimeType(mimeType)) {
      return {
        success: true,
        output: "[BINARY_FILE_DETECTED]",
        isBinary: true,
        metadata: { path: payload.path, mimeType, totalBytes },
        truncated: false,
      };
    }

    const offset = payload.offset ?? 0;
    const limit = payload.limit ?? DEFAULT_READ_LIMIT;
    const result = await runSafeCommand(
      sandbox,
      withToolboxCommandContext(
        {
          command: "awk",
          args: buildReadWindowArgs(targetPath, offset, limit),
          runId,
        },
        toolboxContext,
        "filesystem.read_file",
      ),
      ["awk"],
    );
    if (result.exitCode !== 0) {
      return { success: false, error: result.stderr || "File read failed" };
    }

    const returnedLines = countOutputLines(result.stdout);
    const capped = capReadOutput(result.stdout);
    const totalLines = await this.countLines(
      sandbox,
      targetPath,
      toolboxContext,
      runId,
    );
    const truncated =
      capped.truncated ||
      capped.output.includes("[line truncated]") ||
      (typeof totalLines === "number" && offset + limit < totalLines);
    return {
      success: true,
      output: capped.output,
      metadata: {
        path: payload.path,
        mimeType,
        totalBytes,
        offset,
        limit,
        totalLines,
        returnedLines,
        returnedBytes: capped.output.length,
        narrowHint: truncated
          ? "Use offset/limit or narrow the target file to continue."
          : undefined,
      },
      truncated,
    };
  }

  private async countLines(
    sandbox: Sandbox,
    targetPath: string,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
  ): Promise<number | null> {
    const result = await runSafeCommand(
      sandbox,
      withToolboxCommandContext(
        { command: "wc", args: ["-l", targetPath], runId },
        toolboxContext,
        "filesystem.read_file_line_count",
      ),
      ["wc"],
    );
    if (result.exitCode !== 0) {
      return null;
    }
    return parseLineCount(result.stdout);
  }

  private async makeDirectory(
    sandbox: Sandbox,
    workspaceRoot: string,
    payload: Extract<FileSystemPayload, { action: "make_dir" }>,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
  ): Promise<PluginResult> {
    const targetPath = resolveWorkspacePath(workspaceRoot, payload.path);
    const result = await runSafeCommand(
      sandbox,
      withToolboxCommandContext(
        { command: "mkdir", args: ["-p", targetPath], runId },
        toolboxContext,
        "filesystem.make_dir",
      ),
      ["mkdir"],
    );
    return {
      success: result.exitCode === 0,
      output: result.exitCode === 0 ? "Directory created" : result.stderr,
      error: result.exitCode === 0 ? undefined : result.stderr,
    };
  }
}

const BINARY_MIME_PREFIXES = [
  "image/",
  "video/",
  "audio/",
  "font/",
  "application/pdf",
  "application/zip",
  "application/x-tar",
  "application/x-gzip",
  "application/x-bzip",
  "application/x-7z-compressed",
  "application/x-rar",
  "application/octet-stream",
  "application/x-executable",
  "application/x-sharedlib",
  "application/x-msdownload",
  "application/vnd.",
];

function isBinaryMimeType(mimeType: string): boolean {
  const normalized = mimeType.toLowerCase();
  return BINARY_MIME_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function shouldGuardUnconditionalRead(
  payload: Extract<FileSystemPayload, { action: "read_file" }>,
): boolean {
  return (
    (payload.offset === undefined || payload.offset === 0) &&
    payload.limit === undefined
  );
}

function buildReadWindowArgs(
  targetPath: string,
  offset: number,
  limit: number,
): string[] {
  return [
    "-v",
    `start=${offset + 1}`,
    "-v",
    `limit=${limit}`,
    "-v",
    `max=${MAX_READ_LINE_LENGTH}`,
    'NR >= start { line=$0; if (length(line) > max) line=substr(line, 1, max) " [line truncated]"; print line; count++; if (count >= limit) exit }',
    targetPath,
  ];
}

function capReadOutput(output: string): { output: string; truncated: boolean } {
  const capped = truncateUtf8(
    output,
    MAX_READ_OUTPUT_BYTES,
    "\n[output truncated]",
  );
  return { output: capped.value, truncated: capped.truncated };
}

function countOutputLines(output: string): number {
  if (output.length === 0) {
    return 0;
  }
  return output.endsWith("\n")
    ? output.split(/\r?\n/).length - 1
    : output.split(/\r?\n/).length;
}

function parseLineCount(output: string): number | null {
  const value = Number(output.trim().split(/\s+/)[0]);
  return Number.isFinite(value) ? value : null;
}
