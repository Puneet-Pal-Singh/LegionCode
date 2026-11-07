import type { RuntimeExecutionService } from "../types.js";
import {
  codingToolRegistry,
  READ_FILE_TOOL_INPUT_SCHEMA,
} from "../tools/CodingToolRegistry.js";
import type { LocalReadOnlyWorkspaceBinding } from "./LocalReadOnlyWorkspaceBinding.js";
import type { LocalTurnAttemptIdentity } from "./LocalReadOnlyTurnExecutor.js";
import { formatLocalReadFile } from "./LocalReadFileOutput.js";

/** Read-only adapter for NativeFilesystemBridge.readFile bound to the host's held root FD.
 * The host supplies the real bound method; this adapter has no file-opening,
 * helper-path, LCFM framing or mutation authority.
 */
export function createNativeReadExecutionService(options: {
  readonly attempt: LocalTurnAttemptIdentity;
  readonly binding: LocalReadOnlyWorkspaceBinding;
  readonly readFile: (input: {
    readonly path: string;
    readonly signal: AbortSignal;
  }) => Promise<{
    path: string;
    content: string;
    bytes: number;
  }>;
}): RuntimeExecutionService {
  const attempt = { ...options.attempt };
  const binding = options.binding;
  const readFile = options.readFile;
  return {
    async execute(plugin, action, payload, execution) {
      const route = codingToolRegistry.getDefinition("read_file");
      if (
        !route ||
        route.sandboxClass !== "read" ||
        route.route.plugin !== plugin ||
        route.route.action !== action
      ) {
        throw new Error("Native read-only execution denies this tool route");
      }
      const scope = execution?.scope;
      if (
        !scope ||
        scope.workspaceId !== attempt.workspaceId ||
        scope.threadId !== attempt.threadId ||
        scope.runId !== attempt.runId ||
        scope.turnId !== attempt.turnId ||
        scope.runAttemptId !== attempt.runAttemptId ||
        binding.workspace.workspaceId !== attempt.workspaceId ||
        scope.root !== binding.filesystemRoot
      ) {
        throw new Error("Native read does not match the granted exact attempt");
      }
      const input = READ_FILE_TOOL_INPUT_SCHEMA.parse(payload);
      if (/[\r\n\0]/.test(input.path))
        throw new Error(
          "Control characters are not allowed in workspace paths",
        );
      const signal = execution.signal
        ? AbortSignal.any([execution.signal, binding.signal])
        : binding.signal;
      signal.throwIfAborted();
      await binding.assertCurrent();
      signal.throwIfAborted();
      // readFile is the actual bridge R operation, which resolves only after child and pipe closure.
      const result = await readFile({ path: input.path, signal });
      await binding.assertCurrent();
      signal.throwIfAborted();
      if (
        result.path !== input.path ||
        !Number.isSafeInteger(result.bytes) ||
        result.bytes < 0 ||
        result.bytes > 4 * 1024 * 1024 ||
        Buffer.byteLength(result.content, "utf8") !== result.bytes
      ) {
        throw new Error("Native read returned an invalid bounded receipt");
      }
      return formatLocalReadFile({
        path: input.path,
        content: result.content,
        offset: input.offset,
        limit: input.limit,
      });
    },
  };
}
