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
  description: "Run one executable with exact arguments. Subprocess creation, shell pipelines and subprocess-based package runners are unsupported. No shell parsing or expansion occurs.",
  inputSchema: RUN_EXECUTABLE_TOOL_INPUT_SCHEMA,
  permission: { mode: "approval_required", scope: "workspace" },
  sandboxClass: "write",
  requiredBackendCapabilities: ["single_executable_nofork", "approval"],
  parallelism: "exclusive_workspace_write",
  tokenPolicy: { maxOutputBytes: 128 * 1024 },
  outputRenderer: "shell",
  evidenceKinds: ["command_run"],
  preferredFor: ["single-process tests and executable checks"],
  avoidWhen: ["commands requiring subprocesses, pipelines, network access or filesystem access outside the declared grant and runtime read paths"],
  route: { plugin: "node", action: "run_executable" },
} satisfies Pick<ToolDefinition, "id" | "title" | "description" | "inputSchema" | "permission" | "sandboxClass" | "requiredBackendCapabilities" | "parallelism" | "tokenPolicy" | "outputRenderer" | "evidenceKinds" | "preferredFor" | "avoidWhen"> & {
  route: Omit<ToolDefinition["route"], "toolName">;
};
