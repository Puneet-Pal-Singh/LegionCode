import { isAbsolute, join } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

/** Narrow native supplement. The canonical host still enforces the complete frozen OS grant,
 * including real Git common directories, other users' roots and privileged control APIs.
 * Native socket/network flags are not evidence that the outer cloud boundary is closed.
 */
export function claudeSandbox(input: {
  readonly workspaceRoot: string;
  readonly homeDirectory: string;
  readonly instanceDirectory: string;
  readonly journalDirectory: string;
}): Pick<Options, "sandbox" | "settings"> {
  const roots = [
    input.workspaceRoot,
    input.homeDirectory,
    input.instanceDirectory,
    input.journalDirectory,
  ];
  if (roots.some((path) => !path || !isAbsolute(path)))
    throw new Error("Claude sandbox requires absolute host-owned paths");
  const gitMetadata = join(input.workspaceRoot, ".git");
  const protectedDirectories = [
    input.homeDirectory,
    input.instanceDirectory,
    input.journalDirectory,
  ];
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      excludedCommands: [],
      enableWeakerNestedSandbox: false,
      enableWeakerNetworkIsolation: false,
      allowNestedUserNamespaces: false,
      allowAppleEvents: false,
      network: {
        allowedDomains: [],
        strictAllowlist: true,
        allowUnixSockets: [],
        allowAllUnixSockets: false,
        allowLocalBinding: false,
        allowMachLookup: [],
      },
      filesystem: {
        disabled: false,
        allowWrite: [input.workspaceRoot],
        denyWrite: [
          gitMetadata,
          input.instanceDirectory,
          input.journalDirectory,
        ],
        denyRead: protectedDirectories,
        // Workspaces commonly live below HOME; re-allow only the selected root.
        allowRead: [input.workspaceRoot],
      },
      credentials: {
        files: [
          { path: input.instanceDirectory, mode: "deny" },
          { path: input.journalDirectory, mode: "deny" },
        ],
        envVars: [{ name: "ANTHROPIC_API_KEY", mode: "deny" }],
      },
    },
    settings: {
      permissions: {
        defaultMode: "default",
        disableBypassPermissionsMode: "disable",
        blockReadsOutsideWorkingDirectories: true,
        blockWritesOutsideWorkingDirectories: true,
        // Git mutations belong to the canonical Git boundary, never shell-name filtering.
        deny: [
          "Edit(./.git/**)",
          "Write(./.git/**)",
          "NotebookEdit(./.git/**)",
          "WebFetch",
          "WebSearch",
        ],
      },
    },
  };
}
