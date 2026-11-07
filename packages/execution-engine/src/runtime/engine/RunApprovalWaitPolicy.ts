import type {
  ApprovalDecisionKind,
  ApprovalRequest,
} from "@repo/shared-types";
import type { RunRepository } from "../run/index.js";
import type { RunEventRecorder } from "../events/index.js";
import type { RunEngineEnv } from "./RunEngine.js";
import type { PermissionApprovalStore } from "./PermissionApprovalStore.js";

const TEST_APPROVAL_WAIT_TIMEOUT_MS = 50;
const DEFAULT_APPROVAL_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const APPROVAL_WAIT_POLL_INTERVAL_MS = 250;

export interface ApprovalWaitOutcome {
  outcome: "approved" | "denied" | "aborted" | "timed_out" | "cancelled";
  decision?: ApprovalDecisionKind;
}

export async function waitForApprovalDecision(input: {
  request: ApprovalRequest;
  env: RunEngineEnv;
  runId: string;
  runRepo: RunRepository;
  permissionApprovalStore: PermissionApprovalStore;
}): Promise<ApprovalWaitOutcome> {
  const timeoutMs = resolveApprovalWaitTimeoutMs(input.env);
  const startedAt = Date.now();
  const pollIntervalMs = Math.min(APPROVAL_WAIT_POLL_INTERVAL_MS, timeoutMs);

  while (Date.now() - startedAt < timeoutMs) {
    const currentRun = await input.runRepo.getById(input.runId);
    if (currentRun?.status === "CANCELLED") {
      return { outcome: "cancelled" };
    }

    const resolvedDecision =
      await input.permissionApprovalStore.getResolvedDecision(
        input.request.requestId,
      );
    if (resolvedDecision) {
      if (resolvedDecision.status === "approved") {
        if (resolvedDecision.decision === "allow_once") {
          await input.permissionApprovalStore.isActionAllowed(
            input.request.actionFingerprint,
          );
        }
        return {
          outcome: "approved",
          decision: resolvedDecision.decision,
        };
      }
      if (resolvedDecision.status === "aborted") {
        return {
          outcome: "aborted",
          decision: resolvedDecision.decision,
        };
      }
      return {
        outcome: "denied",
        decision: resolvedDecision.decision,
      };
    }

    const isApproved = await input.permissionApprovalStore.isActionAllowed(
      input.request.actionFingerprint,
    );
    if (isApproved) {
      return { outcome: "approved", decision: "allow_once" };
    }

    const pending = await input.permissionApprovalStore.getPendingRequest();
    if (!pending || pending.requestId !== input.request.requestId) {
      return { outcome: "timed_out" };
    }

    await waitForApprovalPollCycle(pollIntervalMs);
  }

  return { outcome: "timed_out" };
}

export async function ensureApprovalResolvedEventRecorded(input: {
  runEventRecorder: RunEventRecorder;
  requestId: string;
  decision: ApprovalDecisionKind;
  status: "approved" | "denied" | "aborted";
}): Promise<void> {
  await input.runEventRecorder.recordApprovalResolvedIfNotExists({
    requestId: input.requestId,
    decision: input.decision,
    status:
      input.status === "approved"
        ? "approved"
        : input.status === "aborted"
          ? "aborted"
          : "denied",
  });
}

export function resolveApprovalWaitTimeoutMs(env: RunEngineEnv): number {
  const configured = parseOptionalNumber(env.APPROVAL_WAIT_TIMEOUT_MS);
  if (typeof configured === "number" && configured > 0) {
    return configured;
  }

  return env.NODE_ENV === "test"
    ? TEST_APPROVAL_WAIT_TIMEOUT_MS
    : DEFAULT_APPROVAL_WAIT_TIMEOUT_MS;
}

function parseOptionalNumber(value?: string): number | undefined {
  if (!value || value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function waitForApprovalPollCycle(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
