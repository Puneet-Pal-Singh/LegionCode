import { CLAUDE_TRANSPORT_FAMILY } from "./settings.js";

/** Presentation metadata only. Host policy determines actual availability. */
export const claudeHarness = {
  kind: "claude",
  label: "Claude Agent",
  transport: CLAUDE_TRANSPORT_FAMILY,
  accountQuota: "unavailable",
  subscriptionAccess: "requires-provider-approval",
} as const;
