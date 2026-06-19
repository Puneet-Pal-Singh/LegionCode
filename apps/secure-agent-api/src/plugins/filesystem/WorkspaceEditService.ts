import path from "node:path";
import type { Sandbox } from "@cloudflare/sandbox";
import type { PluginResult } from "../../interfaces/types";
import { resolveWorkspacePath } from "../security/PathGuard";
import { runSafeCommand } from "../security/SafeCommand";
import {
  type ToolboxCommandContext,
  withToolboxCommandContext,
} from "../security/ToolboxCommandContext";

const MAX_EDIT_COUNT = 20;

export interface WorkspaceEditContext {
  sandbox: Sandbox;
  workspaceRoot: string;
  toolboxContext: ToolboxCommandContext;
  runId: string;
}

export interface WriteFileInput {
  path: string;
  content: string;
  expectedSha256?: string;
}

export interface ExactEditInput {
  path: string;
  oldText: string;
  newText: string;
  replaceAll?: boolean;
  expectedReplacements?: number;
  expectedSha256?: string;
}

interface PreparedEdit {
  path: string;
  targetPath: string;
  originalContent: string;
  nextContent: string;
  replacementCount: number;
}

export class WorkspaceEditService {
  async write(
    context: WorkspaceEditContext,
    input: WriteFileInput,
  ): Promise<PluginResult> {
    const targetPath = await this.resolveWritablePath(context, input.path);
    await this.assertExpectedHash(
      context.sandbox,
      targetPath,
      input.expectedSha256,
    );
    await this.atomicWrite(context, targetPath, input.content);
    return buildWriteResult(input.path, input.content);
  }

  async edit(
    context: WorkspaceEditContext,
    input: ExactEditInput,
  ): Promise<PluginResult> {
    const prepared = await this.prepareEdit(context, input);
    await this.atomicWrite(context, prepared.targetPath, prepared.nextContent);
    return buildEditResult(prepared);
  }

  async multiEdit(
    context: WorkspaceEditContext,
    edits: ExactEditInput[],
  ): Promise<PluginResult> {
    if (edits.length === 0 || edits.length > MAX_EDIT_COUNT) {
      throw new Error(`multi_edit requires 1-${MAX_EDIT_COUNT} edits`);
    }
    assertUniqueEditPaths(edits);
    const prepared = await Promise.all(
      edits.map((edit) => this.prepareEdit(context, edit)),
    );
    await this.applyPreparedEdits(context, prepared);
    return buildMultiEditResult(prepared);
  }

  private async prepareEdit(
    context: WorkspaceEditContext,
    input: ExactEditInput,
  ): Promise<PreparedEdit> {
    const targetPath = await this.resolveWritablePath(context, input.path);
    const originalContent = await readTextFile(context.sandbox, targetPath);
    await assertHash(originalContent, input.expectedSha256);
    const replacement = replaceExactText(originalContent, input);
    return {
      path: input.path,
      targetPath,
      originalContent,
      nextContent: replacement.content,
      replacementCount: replacement.count,
    };
  }

  private async applyPreparedEdits(
    context: WorkspaceEditContext,
    edits: PreparedEdit[],
  ): Promise<void> {
    const applied: PreparedEdit[] = [];
    try {
      for (const edit of edits) {
        await this.atomicWrite(context, edit.targetPath, edit.nextContent);
        applied.push(edit);
      }
    } catch (error) {
      await this.rollbackEdits(context, applied);
      throw error;
    }
  }

  private async rollbackEdits(
    context: WorkspaceEditContext,
    edits: PreparedEdit[],
  ): Promise<void> {
    for (const edit of [...edits].reverse()) {
      await this.atomicWrite(context, edit.targetPath, edit.originalContent);
    }
  }

  private async resolveWritablePath(
    context: WorkspaceEditContext,
    inputPath: string,
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
        "filesystem.edit.resolve_path",
      ),
      ["realpath"],
    );
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || "Unable to resolve edit path");
    }
    return assertWithinWorkspace(context.workspaceRoot, result.stdout.trim());
  }

  private async assertExpectedHash(
    sandbox: Sandbox,
    targetPath: string,
    expectedSha256: string | undefined,
  ): Promise<void> {
    if (!expectedSha256) {
      return;
    }
    const content = await readTextFile(sandbox, targetPath);
    await assertHash(content, expectedSha256);
  }

  private async atomicWrite(
    context: WorkspaceEditContext,
    targetPath: string,
    content: string,
  ): Promise<void> {
    const parentDir = path.posix.dirname(targetPath);
    await runCheckedCommand(context, "mkdir", ["-p", parentDir]);
    const tempPath = `${parentDir}/.shadowbox-edit-${crypto.randomUUID()}.tmp`;
    try {
      await context.sandbox.writeFile(tempPath, content);
      await runCheckedCommand(context, "mv", [
        "-f",
        "--",
        tempPath,
        targetPath,
      ]);
    } catch (error) {
      await runSafeCommand(
        context.sandbox,
        { command: "rm", args: ["-f", "--", tempPath], runId: context.runId },
        ["rm"],
      );
      throw error;
    }
  }
}

async function runCheckedCommand(
  context: WorkspaceEditContext,
  command: "mkdir" | "mv",
  args: string[],
): Promise<void> {
  const result = await runSafeCommand(
    context.sandbox,
    withToolboxCommandContext(
      { command, args, runId: context.runId },
      context.toolboxContext,
      `filesystem.edit.${command}`,
    ),
    [command],
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `${command} failed`);
  }
}

async function readTextFile(
  sandbox: Sandbox,
  targetPath: string,
): Promise<string> {
  const result = await sandbox.readFile(targetPath, { encoding: "utf-8" });
  if (!result.success || typeof result.content !== "string") {
    throw new Error("Unable to read edit target");
  }
  return result.content;
}

function replaceExactText(
  content: string,
  input: ExactEditInput,
): { content: string; count: number } {
  const count = countOccurrences(content, input.oldText);
  if (count === 0) {
    throw new Error(`Exact edit text was not found in ${input.path}`);
  }
  if (!input.replaceAll && count !== 1) {
    throw new Error(
      `Exact edit is ambiguous in ${input.path}: found ${count} matches`,
    );
  }
  if (
    input.expectedReplacements !== undefined &&
    count !== input.expectedReplacements
  ) {
    throw new Error(
      `Expected ${input.expectedReplacements} replacement match(es) in ${input.path}, found ${count}`,
    );
  }
  const nextContent = input.replaceAll
    ? content.split(input.oldText).join(input.newText)
    : content.replace(input.oldText, input.newText);
  return { content: nextContent, count: input.replaceAll ? count : 1 };
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let cursor = 0;
  while (cursor <= content.length - needle.length) {
    const match = content.indexOf(needle, cursor);
    if (match < 0) {
      break;
    }
    count += 1;
    cursor = match + needle.length;
  }
  return count;
}

async function assertHash(
  content: string,
  expectedSha256: string | undefined,
): Promise<void> {
  if (!expectedSha256) {
    return;
  }
  const actual = await sha256(content);
  if (actual !== expectedSha256.toLowerCase()) {
    throw new Error(
      `Edit conflict: expected sha256 ${expectedSha256}, found ${actual}`,
    );
  }
}

async function sha256(content: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function assertWithinWorkspace(
  workspaceRoot: string,
  resolvedPath: string,
): string {
  const rootPrefix = workspaceRoot.endsWith("/")
    ? workspaceRoot
    : `${workspaceRoot}/`;
  if (resolvedPath !== workspaceRoot && !resolvedPath.startsWith(rootPrefix)) {
    throw new Error("Access Denied: resolved edit path escapes workspace root");
  }
  return resolvedPath;
}

function assertUniqueEditPaths(edits: ExactEditInput[]): void {
  const paths = new Set(edits.map((edit) => edit.path));
  if (paths.size !== edits.length) {
    throw new Error("multi_edit cannot target the same path more than once");
  }
}

function buildWriteResult(filePath: string, content: string): PluginResult {
  return {
    success: true,
    output: `Wrote ${content.length} bytes to ${filePath}`,
    metadata: { path: filePath, bytes: content.length },
    truncated: false,
  };
}

function buildEditResult(edit: PreparedEdit): PluginResult {
  return {
    success: true,
    output: `Edited ${edit.path} (${edit.replacementCount} replacement(s))`,
    metadata: { path: edit.path, replacementCount: edit.replacementCount },
    truncated: false,
  };
}

function buildMultiEditResult(edits: PreparedEdit[]): PluginResult {
  return {
    success: true,
    output: `Edited ${edits.length} files`,
    metadata: {
      files: edits.map((edit) => ({
        path: edit.path,
        replacementCount: edit.replacementCount,
      })),
    },
    truncated: false,
  };
}
