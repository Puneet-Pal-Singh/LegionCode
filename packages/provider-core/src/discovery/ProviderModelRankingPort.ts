import type {
  ProviderModelRankingInput,
  ProviderModelRankingResult,
} from "./types.js";

export interface ProviderModelRankingPort {
  computePopular(input: ProviderModelRankingInput): Promise<ProviderModelRankingResult>;
}
