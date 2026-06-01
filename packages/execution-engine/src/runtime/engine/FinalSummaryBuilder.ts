import { RUN_TERMINAL_STATES, type RunTerminalState } from "@repo/shared-types";

const DEFAULT_DETAIL_FALLBACK =
  "The runtime finished without additional diagnostics.";
const FEATURE_FLAG_KEYS = [
  "finalSummaryContractV1",
  "final_summary_contract_v1",
] as const;

interface FinalSummaryFrameInput {
  terminalState: RunTerminalState;
  detail?: string;
  nextStep?: string;
}

export function isFinalSummaryContractEnabled(
  metadata: Record<string, unknown> | undefined,
  envFlag: string | undefined,
): boolean {
  if (readBooleanLike(envFlag)) {
    return true;
  }

  const featureFlags =
    metadata?.featureFlags && typeof metadata.featureFlags === "object"
      ? (metadata.featureFlags as Record<string, unknown>)
      : undefined;
  if (!featureFlags) {
    return false;
  }

  return FEATURE_FLAG_KEYS.some((key) => readBooleanLike(featureFlags[key]));
}

export function buildFinalSummaryFrame(input: FinalSummaryFrameInput): string {
  const outcome = resolveOutcomeLine(input.terminalState);
  const happened =
    normalizeSummaryLine(input.detail) || DEFAULT_DETAIL_FALLBACK;
  const next =
    normalizeSummaryLine(input.nextStep) ||
    resolveDefaultNextStep(input.terminalState);

  return [
    `Outcome: ${outcome}`,
    `What happened: ${happened}`,
    `What you can do next: ${next}`,
  ].join("\n");
}

export function resolveNextStepFromSummaryText(
  summaryText: string,
): string | undefined {
  const lines = summaryText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const candidate = [...lines].reverse().find((line) => isActionableLine(line));
  return candidate ? stripNextStepFramePrefix(candidate) : undefined;
}

export function resolveSummaryReason(summaryText: string): string {
  const lines = summaryText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return DEFAULT_DETAIL_FALLBACK;
  }

  const preferred = lines.find((line) => !isActionableLine(line));
  return preferred ?? lines[0] ?? DEFAULT_DETAIL_FALLBACK;
}

export function appendTerminalDetailsIfNeeded(input: {
  framedOutput: string;
  originalText: string;
  includeDetails: boolean;
}): string {
  const details = input.originalText.trim();
  if (
    !input.includeDetails ||
    !details ||
    input.framedOutput.includes(details)
  ) {
    return input.framedOutput;
  }

  return `${input.framedOutput}\n\nDetails:\n${details}`;
}

function resolveOutcomeLine(terminalState: RunTerminalState): string {
  switch (terminalState) {
    case RUN_TERMINAL_STATES.COMPLETED:
      return "I completed your request.";
    case RUN_TERMINAL_STATES.COMPLETED_WITH_WARNINGS:
      return "I completed part of your request, but there were warnings.";
    case RUN_TERMINAL_STATES.APPROVAL_REQUIRED:
      return "I need your approval before I can continue.";
    case RUN_TERMINAL_STATES.APPROVAL_RESOLVED:
      return "Your approval decision was recorded.";
    case RUN_TERMINAL_STATES.APPROVAL_DENIED:
      return "I could not continue because approval was denied.";
    case RUN_TERMINAL_STATES.FAILED_TOOL:
      return "I could not finish because a required tool step failed.";
    case RUN_TERMINAL_STATES.FAILED_VALIDATION:
      return "I could not continue because the request did not pass validation.";
    case RUN_TERMINAL_STATES.FAILED_POLICY:
      return "I could not continue because policy blocked this action.";
    case RUN_TERMINAL_STATES.FAILED_RUNTIME:
      return "I could not finish because the runtime hit an internal error.";
    case RUN_TERMINAL_STATES.INTERRUPTED:
      return "The run was interrupted before it completed.";
    default:
      return "The run ended.";
  }
}

function resolveDefaultNextStep(terminalState: RunTerminalState): string {
  switch (terminalState) {
    case RUN_TERMINAL_STATES.COMPLETED:
      return "Tell me the next task and I will continue.";
    case RUN_TERMINAL_STATES.COMPLETED_WITH_WARNINGS:
      return "Retry with a narrower target or tell me which part to continue.";
    case RUN_TERMINAL_STATES.APPROVAL_REQUIRED:
      return "Choose an approval action to continue, or deny to stop this path.";
    case RUN_TERMINAL_STATES.APPROVAL_RESOLVED:
      return "Send your next instruction and I will continue with that decision applied.";
    case RUN_TERMINAL_STATES.APPROVAL_DENIED:
      return "If you want to proceed, allow the action in a new approval decision.";
    case RUN_TERMINAL_STATES.FAILED_TOOL:
      return "Retry the failed step. If it keeps failing, I can pivot to an alternative approach.";
    case RUN_TERMINAL_STATES.FAILED_VALIDATION:
      return "Fix the invalid input and retry.";
    case RUN_TERMINAL_STATES.FAILED_POLICY:
      return "Adjust the request to a policy-allowed action and retry.";
    case RUN_TERMINAL_STATES.FAILED_RUNTIME:
      return "Retry the request. If it repeats, I can narrow scope and re-run safely.";
    case RUN_TERMINAL_STATES.INTERRUPTED:
      return "Resubmit the request when you want me to continue.";
    default:
      return "Retry the request.";
  }
}

function normalizeSummaryLine(value: string | undefined): string {
  if (!value) {
    return "";
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  return normalized.length > 220
    ? `${normalized.slice(0, 217)}...`
    : normalized;
}

function isActionableLine(value: string): boolean {
  const normalized = stripNextStepFramePrefix(value);
  return /^(retry|run|re-run|resubmit|switch|choose|tell|use|allow|deny|fix|adjust)\b/i.test(
    normalized,
  );
}

function stripNextStepFramePrefix(value: string): string {
  return value.replace(/^what you can do next:\s*/i, "").trim();
}

function readBooleanLike(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}
