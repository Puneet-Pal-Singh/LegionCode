import {
  ApprovalRequestSchema,
  RUN_EVENT_TYPES,
  type ApprovalDecisionKind,
  type ApprovalRequest,
  type RunEvent,
} from "@repo/shared-types";
import { z } from "zod";
import {
  getBrainHttpBase,
  runApprovalPath,
} from "../../../lib/platform-endpoints.js";

const RunSummaryPendingApprovalSchema = z.object({
  pendingApproval: ApprovalRequestSchema.nullish(),
});

export async function submitApprovalDecision(input: {
  runId: string;
  requestId: string;
  decision: ApprovalDecisionKind;
}): Promise<Response> {
  return fetch(runApprovalPath(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      runId: input.runId,
      requestId: input.requestId,
      decision: input.decision,
    }),
  });
}

export async function fetchLatestPendingApproval(
  runId: string,
): Promise<ApprovalRequest | null> {
  const response = await fetch(
    `${getBrainHttpBase()}/api/run/summary?runId=${encodeURIComponent(runId)}`,
    {
      credentials: "include",
    },
  );
  if (!response.ok) {
    return null;
  }

  const payload = RunSummaryPendingApprovalSchema.safeParse(
    await response.json(),
  );
  if (!payload.success) {
    console.warn(
      `[chat/interface] Invalid run summary payload while refreshing approval for runId=${runId}`,
      payload.error,
    );
    return null;
  }

  return payload.data.pendingApproval ?? null;
}

export function formatDebugPayload(payload: unknown): string {
  try {
    const serialized = JSON.stringify(payload, null, 2);
    if (!serialized) {
      return "(empty payload)";
    }
    if (serialized.length > 5000) {
      return `${serialized.slice(0, 5000)}\n...<truncated>`;
    }
    return serialized;
  } catch {
    return String(payload);
  }
}

export async function readApprovalErrorMessage(
  response: Response,
): Promise<string> {
  const raw = await response.text();
  if (!raw.trim()) {
    return `Failed to resolve approval (${response.status})`;
  }

  try {
    const parsed = JSON.parse(raw) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return parsed.error.trim();
    }
    if (typeof parsed.message === "string" && parsed.message.trim()) {
      return parsed.message.trim();
    }
  } catch {
    // Non-JSON responses fall back to raw text.
  }

  return raw.trim();
}

export function isNoPendingApprovalError(message: string): boolean {
  return message.toLowerCase().includes("no pending approval request found");
}

export function derivePendingApprovalFromEvents(
  events: RunEvent[],
): ApprovalRequest | null {
  if (events.length === 0) {
    return null;
  }

  const pendingByRequestId = new Map<string, ApprovalRequest>();
  for (const event of events) {
    if (event.type === RUN_EVENT_TYPES.APPROVAL_REQUESTED) {
      pendingByRequestId.set(
        event.payload.request.requestId,
        event.payload.request,
      );
      continue;
    }
    if (event.type === RUN_EVENT_TYPES.APPROVAL_RESOLVED) {
      pendingByRequestId.delete(event.payload.requestId);
    }
  }

  const pendingRequests = [...pendingByRequestId.values()];
  if (pendingRequests.length === 0) {
    return null;
  }

  pendingRequests.sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
  return pendingRequests[pendingRequests.length - 1] ?? null;
}
