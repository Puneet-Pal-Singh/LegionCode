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
