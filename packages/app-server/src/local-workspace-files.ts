import { isUtf8 } from "node:buffer";

import type { CheckoutReadFileResult } from "./protocol.js";
import { AppServerOperationError } from "./server.js";
import type { WorkspaceId } from "@repo/platform-protocol";

/** Structural subset of the native reader; no filesystem path/root is exposed. */
export interface LocalWorkspaceFileReader {
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
  constructor(private readonly binding: LocalWorkspaceFilesBinding) {}

  async readFile(input: {
    readonly workspaceId: WorkspaceId;
    readonly path: string;
  }): Promise<CheckoutReadFileResult> {
    return this.binding.withWorkspace(input.workspaceId, async (reader, signal) => {
      signal.throwIfAborted();
      // The native reader enforces the canonical 500-byte UTF-8 relative-path
      // policy and FD-relative traversal. Do not add a second path policy here.
      const result = await reader.readBytes({ path: input.path, signal });
      signal.throwIfAborted();
      if (result.path !== input.path || result.bytes !== result.content.byteLength) {
        throw new Error("Native workspace read returned inconsistent path or byte metadata");
      }
      // Classify actual bounded native bytes, never filenames or caught failures.
      const isBinary = result.content.includes(0) || !isUtf8(result.content);
      const response: CheckoutReadFileResult = {
        output: isBinary ? "" : new TextDecoder("utf-8", { fatal: true }).decode(result.content),
        isBinary,
      };
      // JSON escaping can expand a native text read substantially. Bound the
      // serialized result, retaining envelope headroom under the 1 MiB transport
      // cap. This protocol has no truncation field, so refuse rather than slice.
      if (Buffer.byteLength(JSON.stringify(response), "utf8") > 512 * 1024) {
        throw new AppServerOperationError(
          413, "invalid_request", "Workspace file preview exceeds the supported response size",
          "workspace_file_preview_too_large", false,
        );
      }
      return response;
    });
  }
}
