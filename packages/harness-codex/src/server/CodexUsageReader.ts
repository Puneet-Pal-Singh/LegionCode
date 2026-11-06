import { createHash } from "node:crypto";
import { z } from "zod";
import {
  UsageCostSnapshotSchema,
  type UsageCostSnapshot,
} from "@repo/platform-protocol";
import { CodexStdioTransport } from "./transport/CodexStdioTransport.js";

const count = z.number().int().safe().nonnegative();
const tokens = z.object({
  inputTokens: count,
  outputTokens: count,
  totalTokens: count,
  cachedInputTokens: count,
  reasoningOutputTokens: count,
});
const tokenUsage = z.object({ last: tokens, total: tokens });
const window = z.object({
  usedPercent: z.number().finite().min(0),
  windowDurationMins: z.number().int().positive().nullable(),
  resetsAt: z.number().int().nullable(),
});

/** Measured model activity only. Neither quota nor API-equivalent subscription charges. */
export function codexTurnUsage(
  raw: unknown,
  modelId: string,
): UsageCostSnapshot {
  const usage = tokenUsage.parse(raw);
  return UsageCostSnapshotSchema.parse({
    providerId: "openai",
    modelId,
    inputTokens: usage.last.inputTokens,
    outputTokens: usage.last.outputTokens,
    cachedInputTokens: usage.last.cachedInputTokens,
    reasoningTokens: usage.last.reasoningOutputTokens,
    totalTokens: usage.last.totalTokens,
    currentTurnCost: null,
    cumulativeThreadTokens: usage.total.totalTokens,
    cumulativeThreadCost: null,
    currency: "USD",
    measurementSource: "provider",
  });
}

/** Private account-read identity evidence, never route-only or first-observed identity.
 * The pinned API exposes no API-key identity; those records remain unverifiable.
 * Connection setup must bind the expected digest before attempt admission.
 */
export function codexAccountIdentityFingerprint(raw: unknown): string | null {
  const identity = z
    .object({
      type: z.literal("chatgpt"),
      email: z.string().min(1),
      workspaceName: z.string().nullable(),
    })
    .safeParse(raw);
  if (!identity.success) return null;
  return createHash("sha256")
    .update(
      JSON.stringify({
        source: "codex-account-read-0.167.0",
        type: identity.data.type,
        email: identity.data.email,
        workspaceName: identity.data.workspaceName,
      }),
    )
    .digest("hex");
}

/** Private redacted account reader. Login/refresh/token-bearing APIs are deliberately absent. */
export class CodexUsageReader {
  constructor(private readonly transport: CodexStdioTransport) {}

  async account(): Promise<{
    route: "api_key" | "subscription" | "unavailable";
    checkedAt: string;
    identityFingerprint: string | null;
  }> {
    const response = z
      .object({
        account: z.object({ type: z.string() }).passthrough().nullable(),
      })
      .parse(
        await this.transport.request("account/read", { refreshToken: false }),
      );
    return {
      route:
        response.account?.type === "apiKey"
          ? "api_key"
          : response.account?.type === "chatgpt"
            ? "subscription"
            : "unavailable",
      identityFingerprint: codexAccountIdentityFingerprint(response.account),
      checkedAt: new Date().toISOString(),
    };
  }

  async quota(): Promise<{
    status: "available" | "unavailable";
    checkedAt: string;
    primary: z.infer<typeof window> | null;
    secondary: z.infer<typeof window> | null;
  }> {
    const checkedAt = new Date().toISOString();
    try {
      const response = z
        .object({
          rateLimits: z.object({
            primary: window.nullable(),
            secondary: window.nullable(),
          }),
        })
        .parse(await this.transport.request("account/rateLimits/read", {}));
      return {
        status:
          response.rateLimits.primary || response.rateLimits.secondary
            ? "available"
            : "unavailable",
        checkedAt,
        primary: response.rateLimits.primary,
        secondary: response.rateLimits.secondary,
      };
    } catch {
      // Unavailable telemetry is never interpreted as zero remaining or unlimited quota.
      return {
        status: "unavailable",
        checkedAt,
        primary: null,
        secondary: null,
      };
    }
  }
}
