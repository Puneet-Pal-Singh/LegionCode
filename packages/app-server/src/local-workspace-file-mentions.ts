import {
  LOCAL_WORKSPACE_MENTION_CATALOG_MAX_BYTES,
  LocalWorkspaceFileMentionsParamsSchema,
  LocalWorkspaceFileMentionsResultSchema,
  LocalWorkspaceListFilesResultSchema,
  type LocalWorkspaceFileMentionsParams,
  type LocalWorkspaceFileMentionsResult,
  type LocalWorkspaceListFilesResult,
} from "./protocol.js";
import type { LocalWorkspaceFileReader } from "./local-workspace-files.js";
import { AppServerOperationError } from "./server.js";

// Candidate policy only. File browsing remains the owner of filesystem access.
// Generated dependency/cache trees are excluded even when explicitly requested.
const EXCLUDED_DIRECTORIES = new Set([
  ".git", ".legioncode", "node_modules", ".pnpm-store", ".yarn", ".venv",
  "__pycache__", ".next", ".nuxt", ".turbo", ".cache", "coverage",
]);
const MAX_PAGES = 128;
const MAX_ENTRIES = 20_000;
const MAX_FILES = 4_000;
const MAX_DEPTH = 24;
const DEADLINE_MS = 5_000;
type Reason = LocalWorkspaceFileMentionsResult["truncationReason"];

/** One borrowed native reader/root for this entire bounded current-name query.
 * No Node filesystem traversal, Git metadata, contents, persistent index or hashes.
 */
export async function collectWorkspaceFileMentions(
  reader: LocalWorkspaceFileReader,
  scopeSignal: AbortSignal,
  input: LocalWorkspaceFileMentionsParams,
): Promise<LocalWorkspaceFileMentionsResult> {
  const request = LocalWorkspaceFileMentionsParamsSchema.parse(input);
  if (request.path.split("/").some((part) => EXCLUDED_DIRECTORIES.has(part.toLowerCase()))) {
    throw new AppServerOperationError(
      400, "invalid_request", "File suggestions exclude dependency and cache directories",
      "workspace_file_mentions_excluded", false,
    );
  }
  scopeSignal.throwIfAborted();
  const deadline = AbortSignal.timeout(DEADLINE_MS);
  const signal = AbortSignal.any([scopeSignal, deadline]);
  const queue = [{ path: request.path, depth: 0 }];
  const files: string[] = [];
  let pages = 0;
  let entries = 0;
  let reason: Reason = null;
  let bytes = Buffer.byteLength(JSON.stringify({
    path: request.path, files: [], truncated: true, truncationReason: "deadline",
  })) + 16;
  const finish = (limit: Reason = reason): LocalWorkspaceFileMentionsResult => {
    scopeSignal.throwIfAborted();
    return LocalWorkspaceFileMentionsResultSchema.parse({
      path: request.path, files: files.sort(), truncated: limit !== null, truncationReason: limit,
    });
  };
  for (let directory = 0; directory < queue.length; directory += 1) {
    const current = queue[directory]!;
    let cursor: string | null = null;
    const cursors = new Set<string>();
    do {
      scopeSignal.throwIfAborted();
      if (deadline.aborted) return finish("deadline");
      if (pages >= MAX_PAGES) return finish("pages");
      let page: LocalWorkspaceListFilesResult;
      try {
        page = LocalWorkspaceListFilesResultSchema.parse(await reader.listDirectory({
          path: current.path, cursor, limit: 200, signal,
        }));
      } catch (error) {
        // Native cleanup completes before the reader rejects. Grant revocation
        // always wins over the filename budget and never returns old-scope names.
        scopeSignal.throwIfAborted();
        if (deadline.aborted) return finish("deadline");
        throw error;
      }
      scopeSignal.throwIfAborted();
      if (page.path !== current.path) throw new Error("Filename catalog returned a different directory");
      pages += 1;
      for (const entry of page.entries) {
        entries += 1;
        if (entries > MAX_ENTRIES) return finish("entries");
        if (entry.unavailableReason) continue;
        if (entry.kind === "file") {
          if (files.length >= MAX_FILES) return finish("files");
          const nextBytes = Buffer.byteLength(JSON.stringify(entry.path)) + 1;
          if (bytes + nextBytes > LOCAL_WORKSPACE_MENTION_CATALOG_MAX_BYTES) return finish("bytes");
          files.push(entry.path);
          bytes += nextBytes;
        } else if (entry.kind === "directory" && !EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())) {
          if (current.depth >= MAX_DEPTH) reason ??= "depth";
          else queue.push({ path: entry.path, depth: current.depth + 1 });
        }
        // Symlinks and special entries are never traversed or offered as files.
      }
      cursor = page.nextCursor;
      if (cursor !== null) {
        if (cursors.has(cursor)) throw new Error("Filename catalog cursor did not advance");
        cursors.add(cursor);
      }
    } while (cursor !== null);
  }
  return finish();
}
