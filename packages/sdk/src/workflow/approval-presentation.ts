import {
  ApprovalExecutionPresentationSchema,
  type ApprovalExecutionPresentation,
} from "@repo/platform-protocol";
import type { WorkflowApproval } from "./turn-workflow-projection.js";

export type WorkflowApprovalPresentation =
  | { status: "available"; available: true; title: string; command: string; cwd: string; execution: ApprovalExecutionPresentation }
  | { status: "unavailable"; available: false; title?: never; cwd?: never; command: string }
  | { status: "not_applicable"; available: false; title?: never; cwd?: never; command?: never };

/** Read exact canonical display facts; never reconstruct consent from tool rows or summaries. */
export function projectApprovalPresentation(
  approval: Pick<WorkflowApproval, "metadata">,
): WorkflowApprovalPresentation {
  const presentation = approval.metadata?.presentation;
  const parsed = ApprovalExecutionPresentationSchema.safeParse(presentation);
  if (!parsed.success) {
    const executableExpected = approval.metadata?.toolName === "run_executable" ||
      (typeof presentation === "object" && presentation !== null &&
        !Array.isArray(presentation) && "kind" in presentation && presentation.kind === "executable");
    return executableExpected ? {
      status: "unavailable",
      available: false,
      command: "Exact action details are unavailable for this saved request.",
    } : { status: "not_applicable", available: false };
  }
  const execution = parsed.data;
  return {
    status: "available",
    available: true,
    title: execution.title,
    cwd: execution.cwd,
    execution,
    command: [
      `Executable (no shell): ${quoteLiteral(execution.executable)}`,
      `Arguments: [${execution.args.map(quoteLiteral).join(", ")}]`,
      `Working directory (workspace-relative): ${quoteLiteral(execution.cwd)}`,
    ].join("\n"),
  };
}

/** Quotes preserve empty arguments, whitespace and control characters without shell parsing. */
function quoteLiteral(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
