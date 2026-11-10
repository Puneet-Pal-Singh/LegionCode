import { isUtf8 } from "node:buffer";

import { LOCAL_WORKSPACE_FILE_PREVIEW_MAX_BYTES, type CheckoutReadFileResult, type LocalWorkspaceListFilesParams, type LocalWorkspaceListFilesResult, type LocalWorkspaceReadFileParams } from "./protocol.js";
import { AppServerOperationError } from "./server.js";
import type { WorkspaceId } from "@repo/platform-protocol";
import type { LocalWorkspaceFileMentionsParams, LocalWorkspaceFileMentionsResult } from "./protocol.js";
import { collectWorkspaceFileMentions } from "./local-workspace-file-mentions.js";

const MAX_ACTIVE_WORKSPACE_FILE_READS = 4;

interface DirectoryPage {
  readonly path: string;
  readonly entries: readonly {
    readonly name: string;
    readonly path: string;
    readonly kind: "file" | "directory" | "symlink" | "other";
    readonly bytes: number;
    readonly mode: number;
    readonly unavailableReason?: "reserved_path";
  }[];
  readonly truncated: boolean;
  readonly nextCursor: string | null;
}

/** Structural subset of the native reader; no filesystem path/root is exposed. */
export interface LocalWorkspaceFileReader {
  listDirectory(input: {
    readonly path: string;
    readonly limit?: number;
    readonly cursor?: string | null;
    readonly signal: AbortSignal;
  }): Promise<DirectoryPage>;
  readBytes(input: {
    readonly path: string;
    readonly signal: AbortSignal;
  }): Promise<{ path: string; content: Uint8Array; bytes: number }>;
}

export interface LocalWorkspaceFilesBinding {
  /** Trusted composition validates the current grant, owns the root FD lifetime,
   * and awaits native cleanup before releasing it. Revocation must invalidate
   * this operation; no renderer-supplied root or synthetic turn is accepted.
   */
  withWorkspace<T>(
    workspaceId: WorkspaceId,
    operation: (reader: LocalWorkspaceFileReader, signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
}

/** Current workspace reads only. Immutable review uses the saved artifact owner. */
export class LocalWorkspaceFilesService {
  private activeReads = 0;

  constructor(private readonly binding: LocalWorkspaceFilesBinding) {}

  async fileMentions(input: LocalWorkspaceFileMentionsParams): Promise<LocalWorkspaceFileMentionsResult> {
    return this.withWorkspace(input.workspaceId, (reader, signal) =>
      collectWorkspaceFileMentions(reader, signal, input),
    );
  }

  async listFiles(input: LocalWorkspaceListFilesParams): Promise<LocalWorkspaceListFilesResult> {
    return this.withWorkspace(input.workspaceId, async (reader, signal) => {
      signal.throwIfAborted();
      const page = await reader.listDirectory({
        path: input.path, limit: input.limit ?? 200, cursor: input.cursor, signal,
      });
      signal.throwIfAborted();
      if (page.path !== input.path) {
        throw new Error("Native directory read returned a different path");
      }
      // Preserve all native kinds and metadata. The bridge validates page size,
      // cursor/version and truncation; stale cursors are errors, never restarts.
      return {
        path: page.path,
        entries: page.entries.map((entry) => ({ ...entry })),
        truncated: page.truncated,
        nextCursor: page.nextCursor,
      };
    });
  }

  async readFile(input: LocalWorkspaceReadFileParams): Promise<CheckoutReadFileResult> {
    return this.withWorkspace(input.workspaceId, async (reader, signal) => {
      signal.throwIfAborted();
      // The native reader enforces the canonical 500-byte UTF-8 relative-path
      // policy and FD-relative traversal. Do not add a second path policy here.
      const result = await reader.readBytes({ path: input.path, signal });
      signal.throwIfAborted();
      if (result.path !== input.path || result.bytes !== result.content.byteLength) {
        throw new Error("Native workspace read returned inconsistent path or byte metadata");
      }
      if (result.bytes > LOCAL_WORKSPACE_FILE_PREVIEW_MAX_BYTES) {
        throw new AppServerOperationError(
          413, "invalid_request", "Workspace file exceeds the 64 KiB preview limit",
          "workspace_file_too_large", false,
        );
      }
      // Classify actual bounded native bytes, never filenames or caught failures.
      const isBinary = result.content.includes(0) || !isUtf8(result.content);
      const response: CheckoutReadFileResult = {
        output: isBinary ? "" : new TextDecoder("utf-8", { fatal: true }).decode(result.content),
        isBinary,
      };
      // The canonical raw bound also caps worst-case escaped JSON below 1 MiB.
      return response;
    });
  }

  private async withWorkspace<T>(
    workspaceId: WorkspaceId,
    operation: (reader: LocalWorkspaceFileReader, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    // Reserve synchronously, before grant/Git binding or native child creation.
    if (this.activeReads >= MAX_ACTIVE_WORKSPACE_FILE_READS) {
      throw new AppServerOperationError(
        503, "server_unavailable", "Workspace file queries are busy",
        "workspace_files_busy", false,
      );
    }
    this.activeReads += 1;
    try {
      // Await the whole trusted binding: its finally closes the grant FD only
      // after native child/pipe cleanup. UI cancellation does not free a slot.
      return await this.binding.withWorkspace(workspaceId, operation);
    } finally {
      this.activeReads -= 1;
    }
  }

}
