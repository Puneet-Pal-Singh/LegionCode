import type { Env } from "../../types/ai";
import { createOpenAIAdapter } from "../ai/ProviderAdapterFactory";
import { OPENROUTER_BASE_URL } from "../ai/defaults";
import { generateText } from "../ai/TextGenerationService";
import type { ThreadTitleGenerator } from "./ThreadTitleGenerationCoordinator";

const OPENROUTER_FREE_MODEL_ID = "openrouter/free";

/**
 * Creates the platform-owned, OpenRouter-only fallback used for title metadata.
 * The key never enters the user-scoped provider store or the client payload.
 */
export function createOpenRouterThreadTitleGenerator(
  env: Env,
): ThreadTitleGenerator | undefined {
  const apiKey = env.AXIS_OPENROUTER_API_KEY?.trim();
  if (!apiKey) return undefined;

  const adapter = createOpenAIAdapter(
    env,
    apiKey,
    OPENROUTER_BASE_URL,
    "openrouter",
  );
  return {
    async generateText(input) {
      return generateText(adapter, {
        messages: input.messages,
        model: OPENROUTER_FREE_MODEL_ID,
        temperature: input.temperature,
        maxOutputTokens: input.maxOutputTokens,
        signal: input.signal,
      });
    },
  };
}

export { OPENROUTER_FREE_MODEL_ID };
