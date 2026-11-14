import { createHash } from "node:crypto";
import { ApprovalIdSchema, ItemIdSchema } from "@repo/platform-protocol";
import type { ItemId } from "@repo/platform-protocol";
import type {
  HarnessObservationPayload,
  HarnessRequestOrigin,
} from "@repo/worker-protocol";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";

/** The host callback must commit the canonical decision for this exact origin. */
export function fencedClaudePermission(
  decide: CanUseTool,
  sessionSignal: AbortSignal,
): CanUseTool {
  const consumed = new Set<string>();
  return async (name, input, origin) => {
    const deny = {
      behavior: "deny",
      message: "Claude permission is no longer active",
      interrupt: true,
    } as const;
    if (
      sessionSignal.aborted ||
      origin.signal.aborted ||
      !origin.requestId ||
      consumed.has(origin.requestId) ||
      consumed.size >= 4096
    )
      return deny;
    // Ambiguous delivery never causes a second prompt or reuse of a single-use grant.
    consumed.add(origin.requestId);
    const cancellation = new AbortController();
    const abort = () => cancellation.abort();
    sessionSignal.addEventListener("abort", abort, { once: true });
    origin.signal.addEventListener("abort", abort, { once: true });
    try {
      const decision = await decide(name, input, {
        ...origin,
        signal: cancellation.signal,
      });
      if (!decision || sessionSignal.aborted || origin.signal.aborted)
        return deny;
      if (decision.behavior === "deny")
        return { ...decision, toolUseID: origin.toolUseID };
      // Reusable SDK rules would bypass canonical checks on later requests.
      return {
        behavior: "allow",
        updatedInput: decision.updatedInput,
        toolUseID: origin.toolUseID,
      };
    } finally {
      sessionSignal.removeEventListener("abort", abort);
      origin.signal.removeEventListener("abort", abort);
    }
  };
}

/** Only one-shot choices are offered. Replies are consumed by core's scoped request handle. */
export function claudePermissionObservation(input: {
  readonly replyTo: HarnessRequestOrigin;
  readonly parentItemId: ItemId;
  readonly toolName: string;
}): Extract<HarnessObservationPayload, { kind: "approval_requested" }> {
  const identity = createHash("sha256")
    .update(JSON.stringify(input.replyTo))
    .digest("hex")
    .slice(0, 40);
  return {
    kind: "approval_requested",
    parentItemId: input.parentItemId,
    replyTo: input.replyTo,
    request: {
      approvalId: ApprovalIdSchema.parse(`appr_${identity}`),
      itemId: ItemIdSchema.parse(`itm_approval_${identity}`),
      question: `Allow Claude to use ${input.toolName}?`,
      options: [
        { id: "allow_once", label: "Allow once", description: null },
        { id: "deny", label: "Deny", description: null },
      ],
      metadata: { harness: "claude", nativeOrigin: input.replyTo.origin },
    },
  };
}
