import type { RunTerminalState } from "@repo/shared-types";
import type { NormalizedModelPart } from "../llm/ModelOutputParts.js";
import type { TerminalOutcomeCode } from "./TerminalSettlementProjector.js";

export type FinalVisiblePart = Extract<
  NormalizedModelPart,
  { type: "visible_text" | "final" }
>;

export interface FinalAssistantMessageInput {
  terminalState: RunTerminalState;
  outcomeCode: TerminalOutcomeCode;
  finalParts?: readonly FinalVisiblePart[];
  detail?: string;
  nextStep?: string;
  metadata?: Record<string, unknown>;
}

export interface FinalAssistantMessageResult {
  content: string;
  parts: readonly [{ type: "final"; text: string }];
  source: "model" | "runtime";
  metadata: Record<string, unknown>;
}

/** The only owner allowed to project a user-visible terminal part. */
export class FinalAssistantMessageService {
  build(input: FinalAssistantMessageInput): FinalAssistantMessageResult {
    const modelText = input.finalParts
      ?.map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n\n")
      .trim();
    const source = modelText ? "model" : "runtime";
    const text = modelText || buildRuntimeFinalText(input);
    const metadata = {
      ...(input.metadata ?? {}),
      terminalState: input.terminalState,
      outcomeCode: input.outcomeCode,
      code: input.outcomeCode,
      finalMessageSource: source,
    };

    return {
      content: text,
      parts: [{ type: "final", text }],
      source,
      metadata,
    };
  }
}

function buildRuntimeFinalText(input: FinalAssistantMessageInput): string {
  const outcome = outcomeCopy[input.outcomeCode];
  const detail = input.detail ?? outcome.detail;
  const nextStep = input.nextStep ?? outcome.nextStep;
  return `${outcome.title}\n\n${detail} ${nextStep}`.trim();
}

const outcomeCopy: Record<
  TerminalOutcomeCode,
  { title: string; detail: string; nextStep: string }
> = {
  COMPLETED: {
    title: "The run completed without a model-written final response.",
    detail: "The runtime reached a terminal state.",
    nextStep: "Send the next task when you want me to continue.",
  },
  COMPLETED_WITH_WARNINGS: {
    title: "The run completed with warnings.",
    detail: "Review the warning details before continuing.",
    nextStep: "Send a follow-up when you want me to continue.",
  },
  APPROVAL_REQUIRED: {
    title: "I need your approval before I can continue.",
    detail: "The next action is waiting for an approval decision.",
    nextStep: "Choose an approval action or deny it to stop this path.",
  },
  APPROVAL_DENIED: {
    title: "I stopped because you denied the requested action.",
    detail: "The denied action was not run.",
    nextStep: "Send a revised instruction to continue.",
  },
  TOOL_EXECUTION_FAILED: {
    title: "I could not finish because a required tool step failed.",
    detail: "The terminal failure is recorded in the run evidence.",
    nextStep: "Retry the failed step or send a narrower follow-up.",
  },
  VALIDATION_FAILED: {
    title: "I could not continue because validation failed.",
    detail: "The runtime rejected the requested terminal result.",
    nextStep: "Retry with a narrower request.",
  },
  POLICY_BLOCKED: {
    title: "I could not continue because policy blocked this action.",
    detail: "No blocked action was reported as completed.",
    nextStep: "Request a permitted alternative.",
  },
  INTERRUPTED: {
    title: "The run was interrupted before it completed.",
    detail: "The remaining work was not reported as complete.",
    nextStep: "Resubmit the request when you want me to continue.",
  },
  RUNTIME_FAILED: {
    title: "I could not finish because the runtime hit an internal error.",
    detail: "The runtime recorded the terminal failure.",
    nextStep: "Retry the request or send a narrower follow-up.",
  },
  FINALIZATION_MISSING_EVIDENCE: {
    title: "I cannot finalize that answer yet because required evidence is missing.",
    detail: "The requested result was not projected as successful.",
    nextStep: "Run the missing typed steps and try again.",
  },
};
