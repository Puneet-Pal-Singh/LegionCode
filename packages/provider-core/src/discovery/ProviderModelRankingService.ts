import type { BYOKDiscoveredProviderModel } from "@repo/shared-types";
import type {
  ProviderModelRankingInput,
  ProviderModelRankingResult,
  ProviderModelRankingSignals,
} from "./types.js";
import type { ProviderModelRankingPort } from "./ProviderModelRankingPort.js";

export class ProviderModelRankingService implements ProviderModelRankingPort {
  async computePopular(input: ProviderModelRankingInput): Promise<ProviderModelRankingResult> {
    const scored = input.models.map((model) =>
      attachScore(model, input.signals),
    );
    const sorted = scored.sort(compareByScoreThenId);
    return {
      providerId: input.providerId,
      view: "popular",
      models: sorted.slice(0, input.limit),
    };
  }
}

function attachScore(
  model: BYOKDiscoveredProviderModel,
  signals: ProviderModelRankingSignals,
): BYOKDiscoveredProviderModel {
  const selectionFrequency = lookup(signals.modelSelectionFrequency, model.id);
  const successfulRuns = lookup(signals.successfulRunFrequency, model.id);
  const providerDeclared = lookup(signals.providerDeclaredBoost, model.id);
  const capabilityFit = lookup(signals.capabilityFit, model.id);
  const costEfficiency = lookup(signals.costEfficiency, model.id);
  const score =
    selectionFrequency * 0.4 +
    successfulRuns * 0.3 +
    providerDeclared * 0.1 +
    capabilityFit * 0.1 +
    costEfficiency * 0.1;

  return {
    ...model,
    popularityScore: {
      score,
      signals: {
        selectionFrequency,
        successfulRuns,
        providerDeclared,
        capabilityFit,
        costEfficiency,
      },
    },
  };
}

function compareByScoreThenId(
  a: BYOKDiscoveredProviderModel,
  b: BYOKDiscoveredProviderModel,
): number {
  const scoreA = a.popularityScore?.score ?? 0;
  const scoreB = b.popularityScore?.score ?? 0;
  if (scoreA !== scoreB) {
    return scoreB - scoreA;
  }
  return a.id.localeCompare(b.id);
}

function lookup(map: Record<string, number>, modelId: string): number {
  const value = map[modelId] ?? 0;
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
}
