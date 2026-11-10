import {
  ApprovalExecutionPresentationSchema,
  type ApprovalExecutionPresentation,
} from "@repo/platform-protocol";
import type { WorkflowApproval } from "./turn-workflow-projection.js";

export type WorkflowApprovalPresentation =
  | { available: true; title: string; command: string; cwd: string; execution: ApprovalExecutionPresentation }
  | { available: false; title?: never; cwd?: never; command: string };

/** Read exact canonical display facts; never reconstruct consent from tool rows or summaries. */
export function projectApprovalPresentation(
  approval: Pick<WorkflowApproval, "metadata">,
): WorkflowApprovalPresentation {
  const parsed = ApprovalExecutionPresentationSchema.safeParse(approval.metadata?.presentation);
  if (!parsed.success) return {
    available: false,
    command: "Exact action details are unavailable for this saved request.",
  };
  const execution = parsed.data;
  return {
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
