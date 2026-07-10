import { relative, resolve } from "node:path";
import type { RunAttemptId, WorkspaceId } from "@repo/platform-protocol";

export interface RuntimeWorkspaceScopeInput {
  readonly runId: string;
  readonly runAttemptId: RunAttemptId;
  readonly workspaceId: WorkspaceId;
  readonly root: string;
}

export interface RuntimeWorkspaceExecutionScope {
  readonly runId: string;
  readonly runAttemptId: RunAttemptId;
  readonly workspaceId: WorkspaceId;
  readonly root: string;
}

/**
 * The only authority that turns model supplied paths into executor paths.
 * The executor receives the durable run identity with every dispatch, rather
 * than deriving its root from a session or a previous tool call.
 */
export class RuntimeWorkspaceScope {
  readonly executionScope: RuntimeWorkspaceExecutionScope;

  constructor(input: RuntimeWorkspaceScopeInput) {
    const root = resolve(input.root);
    this.executionScope = { ...input, root };
  }

  normalizeToolInput(input: Record<string, unknown>): Record<string, unknown> {
    const normalized = { ...input };
    this.normalizeField(normalized, "path");
    this.normalizeField(normalized, "cwd");
    this.normalizePathList(normalized, "files");
    this.normalizeEdits(normalized);
    return normalized;
  }

  private normalizeField(
    input: Record<string, unknown>,
    field: "path" | "cwd",
  ): void {
    const value = input[field];
    if (value === undefined) return;
    if (typeof value !== "string") {
      throw new RuntimeWorkspaceScopeError(
        "invalid_workspace_path",
        `${field} must be a string`,
      );
    }
    input[field] = this.toWorkspaceRelativePath(value);
  }

  private normalizePathList(
    input: Record<string, unknown>,
    field: "files",
  ): void {
    const value = input[field];
    if (value === undefined) return;
    if (
      !Array.isArray(value) ||
      !value.every((entry) => typeof entry === "string")
    ) {
      throw new RuntimeWorkspaceScopeError(
        "invalid_workspace_path",
        `${field} must contain only paths`,
      );
    }
    input[field] = value.map((entry) => this.toWorkspaceRelativePath(entry));
  }

  private normalizeEdits(input: Record<string, unknown>): void {
    const value = input.edits;
    if (value === undefined) return;
    if (!Array.isArray(value)) {
      throw new RuntimeWorkspaceScopeError(
        "invalid_workspace_path",
        "edits must be an array",
      );
    }
    input.edits = value.map((entry) => {
      if (!isRecord(entry) || typeof entry.path !== "string") {
        throw new RuntimeWorkspaceScopeError(
          "invalid_workspace_path",
          "each edit requires a path",
        );
      }
      return { ...entry, path: this.toWorkspaceRelativePath(entry.path) };
    });
  }

  private toWorkspaceRelativePath(candidate: string): string {
    const absolute = resolve(this.executionScope.root, candidate);
    const relativePath = relative(this.executionScope.root, absolute);
    if (relativePath === "" || relativePath === ".") return ".";
    if (relativePath === ".." || relativePath.startsWith(`..${"/"}`)) {
      throw new RuntimeWorkspaceScopeError(
        "workspace_escape_denied",
        `Path is outside the run workspace: ${candidate}`,
      );
    }
    return relativePath;
  }
}

export class RuntimeWorkspaceScopeError extends Error {
  constructor(
    readonly code: "invalid_workspace_path" | "workspace_escape_denied",
    message: string,
  ) {
    super(message);
    this.name = "RuntimeWorkspaceScopeError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
