import type { SDKModelConfig } from "./SDKModelFactory";
import {
  GROQ_BASE_URL,
  OPENAI_BASE_URL,
  OPENROUTER_BASE_URL,
} from "@legioncode/execution-engine/runtime/provider/ProviderEndpoints";

export function inferUsageProvider(
  runtimeProvider: SDKModelConfig["provider"],
  providerId: string | undefined,
  baseURL: string,
): string {
  if (providerId) {
    return providerId;
  }

  if (runtimeProvider !== "openai-compatible") {
    return runtimeProvider;
  }

  const normalized = baseURL.toLowerCase();
  if (normalized.includes(new URL(OPENROUTER_BASE_URL).host)) {
    return "openrouter";
  }
  if (normalized.includes(new URL(GROQ_BASE_URL).host)) {
    return "groq";
  }
  if (normalized.includes(new URL(OPENAI_BASE_URL).host)) {
    return "openai";
  }

  return "openai-compatible";
}
