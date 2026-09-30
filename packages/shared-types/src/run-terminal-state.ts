import { z } from "zod";

export const RUN_TERMINAL_STATES = {
  COMPLETED: "completed",
  COMPLETED_WITH_WARNINGS: "completed_with_warnings",
  APPROVAL_REQUIRED: "approval_required",
  APPROVAL_RESOLVED: "approval_resolved",
  APPROVAL_DENIED: "approval_denied",
  APPROVAL_TIMED_OUT: "approval_timed_out",
  FAILED_TOOL: "failed_tool",
  FAILED_RUNTIME: "failed_runtime",
  FAILED_VALIDATION: "failed_validation",
  FAILED_POLICY: "failed_policy",
  INTERRUPTED: "interrupted",
} as const;

export const RunTerminalStateSchema = z.enum([
  RUN_TERMINAL_STATES.COMPLETED,
  RUN_TERMINAL_STATES.COMPLETED_WITH_WARNINGS,
  RUN_TERMINAL_STATES.APPROVAL_REQUIRED,
  RUN_TERMINAL_STATES.APPROVAL_RESOLVED,
  RUN_TERMINAL_STATES.APPROVAL_DENIED,
  RUN_TERMINAL_STATES.APPROVAL_TIMED_OUT,
  RUN_TERMINAL_STATES.FAILED_TOOL,
  RUN_TERMINAL_STATES.FAILED_RUNTIME,
  RUN_TERMINAL_STATES.FAILED_VALIDATION,
  RUN_TERMINAL_STATES.FAILED_POLICY,
  RUN_TERMINAL_STATES.INTERRUPTED,
]);

export type RunTerminalState = z.infer<typeof RunTerminalStateSchema>;
