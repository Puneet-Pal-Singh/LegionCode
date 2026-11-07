import { z } from "zod";
import type { ToolDefinition } from "./CodingToolRegistry.js";

const boundedArgument = z.string().max(4_096).refine(
  (value) => !value.includes("\0") && new TextEncoder().encode(value).length <= 4_096,
  "Arguments must be bounded strings without NUL bytes",
);

export const RUN_EXECUTABLE_TOOL_INPUT_SCHEMA = z.object({
  executable: boundedArgument.refine((value) => value.startsWith("/"), "Executable must be an absolute POSIX path"),
  args: z.array(boundedArgument).max(255),
  cwd: z.string().min(1).max(500).refine((value) => !value.includes("\0")).optional(),
  description: z.string().min(1).max(500).optional(),
}).strict();

export type RunExecutableToolInput = z.infer<typeof RUN_EXECUTABLE_TOOL_INPUT_SCHEMA>;

/** Definition data only; canonical registry supplies routing and result adaptation. */
export const RUN_EXECUTABLE_TOOL_DEFINITION = {
  id: "run_executable",
  title: "Run Executable",
  description: "Run one executable with exact arguments using your macOS user file, network and IPC access, including outside this workspace. Subprocess creation is denied; direct signals are limited to self. Cwd is walked from the held workspace directory without symlinks or dot components. No shell parsing or expansion occurs in this tool.",
  inputSchema: RUN_EXECUTABLE_TOOL_INPUT_SCHEMA,
  permission: { mode: "approval_required", scope: "host_user" },
  sandboxClass: "write",
  requiredBackendCapabilities: ["single_executable_nofork", "approval"],
  parallelism: "exclusive_workspace_write",
  tokenPolicy: { maxOutputBytes: 128 * 1024 },
  outputRenderer: "shell",
  evidenceKinds: ["command_run"],
  preferredFor: ["single-process tests and executable checks"],
  avoidWhen: ["commands requiring subprocesses or pipelines", "tasks requiring filesystem, network or IPC confinement"],
  route: { plugin: "node", action: "run_executable" },
} satisfies Pick<ToolDefinition, "id" | "title" | "description" | "inputSchema" | "permission" | "sandboxClass" | "requiredBackendCapabilities" | "parallelism" | "tokenPolicy" | "outputRenderer" | "evidenceKinds" | "preferredFor" | "avoidWhen"> & {
  route: Omit<ToolDefinition["route"], "toolName">;
};
