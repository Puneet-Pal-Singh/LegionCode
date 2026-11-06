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

/** Private redacted account reader. Login/refresh/token-bearing APIs are deliberately absent. */
export class CodexUsageReader {
  constructor(private readonly transport: CodexStdioTransport) {}

  async account(): Promise<{
    route: "api_key" | "subscription" | "unavailable";
    checkedAt: string;
  }> {
    const response = z
      .object({ account: z.object({ type: z.string() }).nullable() })
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
