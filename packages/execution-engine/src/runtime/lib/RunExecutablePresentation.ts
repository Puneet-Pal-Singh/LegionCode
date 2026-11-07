import type { RunExecutableToolInput } from "../tools/RunExecutableTool.js";
import type { ToolPresentation } from "./ToolPresentation.js";

export function presentRunExecutable(input: RunExecutableToolInput): ToolPresentation {
  return {
    description: `Run executable ${input.executable}`,
    displayText: `Running ${input.executable}`,
    summary: `Executable: ${input.executable}; argv: ${JSON.stringify(input.args)}; cwd: ${input.cwd ?? "."}. Runs with your macOS user file/network/IPC access, including outside this workspace. Subprocesses are denied; direct signals are limited to self.`,
  };
}
