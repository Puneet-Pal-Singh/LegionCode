import type { ModelRef, SessionUsageUpdated } from "@opencode/client";
import {
  UsageCostSnapshotSchema,
  type UsageCostSnapshot,
} from "@repo/platform-protocol";
import { OpenCodeTransportError } from "./OpenCodeClient.js";

/** Native session counters are cumulative per session, not account allowance. */
export class OpenCodeUsageReader {
  private readonly sessions = new Map<
    string,
    SessionUsageUpdated["data"]["tokens"]
  >();

  constructor(
    private readonly model: ModelRef,
    private readonly canonicalModelId: string,
    private readonly priorThreadTokens: number,
  ) {}

  observe(event: SessionUsageUpdated): UsageCostSnapshot {
    if (
      !this.sessions.has(event.data.sessionID) &&
      this.sessions.size >= 1000
    ) {
      throw new OpenCodeTransportError("usage session bound", true);
    }
    // Replace snapshots. Adding each usage.updated notification would count the same step repeatedly.
    this.sessions.set(event.data.sessionID, event.data.tokens);
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    let reasoningTokens = 0;
    for (const tokens of this.sessions.values()) {
      inputTokens += tokens.input + tokens.cache.read + tokens.cache.write;
      outputTokens += tokens.output + tokens.reasoning;
      cachedInputTokens += tokens.cache.read;
      reasoningTokens += tokens.reasoning;
    }
    try {
      return UsageCostSnapshotSchema.parse({
        providerId: this.model.providerID,
        modelId: this.canonicalModelId,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        reasoningTokens,
        totalTokens: inputTokens + outputTokens,
        cumulativeThreadTokens:
          this.priorThreadTokens + inputTokens + outputTokens,
        // Native cost can use catalog estimates. It is not evidence of the selected account's bill.
        currentTurnCost: null,
        cumulativeThreadCost: null,
        currency: "USD",
        measurementSource: "provider",
      });
    } catch {
      throw new OpenCodeTransportError("usage validation", true);
    }
  }
}
