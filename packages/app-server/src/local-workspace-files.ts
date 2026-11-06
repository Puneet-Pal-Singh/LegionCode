import type { WorkspaceId } from "@repo/platform-protocol";

/** Structural subset of the native reader; no filesystem path/root is exposed. */
export interface LocalWorkspaceFileReader {
  readFile(input: {
    readonly path: string;
    readonly signal: AbortSignal;
  }): Promise<{ path: string; content: string; bytes: number }>;
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
  constructor(private readonly binding: LocalWorkspaceFilesBinding) {}

  async readFile(input: {
    readonly workspaceId: WorkspaceId;
    readonly relativePath: string;
  }): Promise<{ content: string; bytes: number }> {
    return this.binding.withWorkspace(input.workspaceId, async (reader, signal) => {
      signal.throwIfAborted();
      // The native reader enforces the canonical 500-byte UTF-8 relative-path
      // policy and FD-relative traversal. Do not add a second path policy here.
      const result = await reader.readFile({ path: input.relativePath, signal });
      signal.throwIfAborted();
      if (result.path !== input.relativePath) {
        throw new Error("Native workspace read returned a different path");
      }
      // Preserve the actual decoded text/byte count. Unsupported/binary/native
      // failures propagate; none is reclassified as binary or empty content.
      return { content: result.content, bytes: result.bytes };
    });
  }
}
