import { ApprovalRequestSchema } from "@repo/shared-types";
import { z } from "zod";

const RunSummaryStatusPayloadSchema = z
  .object({
    status: z.string().nullish(),
    pendingApproval: ApprovalRequestSchema.nullish(),
  })
  .passthrough();

export interface RunSummaryStatusSnapshot {
  status: string | null;
  hasPendingApproval: boolean;
}

export function parseRunSummaryStatusSnapshot(
  payload: unknown,
): RunSummaryStatusSnapshot | null {
  const parsed = RunSummaryStatusPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    console.warn(
      "[run/summary] Invalid status snapshot payload",
      parsed.error,
    );
    return null;
  }

  return {
    status: parsed.data.status ?? null,
    hasPendingApproval: parsed.data.pendingApproval != null,
  };
}
