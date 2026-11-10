import type {
  ProviderModelCacheEntry,
  ProviderModelCacheGetInput,
  ProviderModelCacheSetInput,
} from "./types.js";

export interface ProviderModelCachePort {
  get(input: ProviderModelCacheGetInput): Promise<ProviderModelCacheEntry | null>;

  set(input: ProviderModelCacheSetInput): Promise<void>;

  invalidate(input: ProviderModelCacheGetInput): Promise<void>;
}
