import { OPENROUTER_BASE_URL } from "@legioncode/execution-engine/runtime/provider/ProviderEndpoints";
import type { Env } from "../../types/ai";
import { resolveAxisOpenRouterKey } from "../ai/ProviderKeyValidator";

/** Private runtime material only. Persist the fingerprint, never this object. */
export interface NativeAxisCredentialMaterial {
  readonly apiKey: string;
  readonly endpoint: string;
  readonly materialFingerprint: string;
}

/** Pin the existing managed Axis authority without inventing a connection ID.
 * This is content identity, not a monotonic revocation epoch: A -> B -> A has
 * the original fingerprint. The model and admitted runtime route are separate
 * frozen selection fields, not inputs from mutable workspace preferences. */
export async function captureNativeAxisMaterial(
  env: Env,
): Promise<NativeAxisCredentialMaterial> {
  const { apiKey, baseURL } = resolveAxisOpenRouterKey(env);
  if (baseURL !== OPENROUTER_BASE_URL) throw unavailable();
  // Canonical tuple for the managed OpenAI-compatible chat transport: the
  // authority has a fixed endpoint and no per-connection headers/configuration.
  const encoded = new TextEncoder().encode(JSON.stringify([
    "legioncode/native-axis-material/v1",
    "axis",
    "platform_managed",
    "openai-chat-completions",
    baseURL,
    {},
    apiKey,
  ]));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return Object.freeze({ apiKey, endpoint: baseURL, materialFingerprint: `sha256:${hex}` });
}

/** Revalidate once and return that SAME captured key/endpoint across the await.
 * No credential/default lookup or second environment read may replace it. */
export async function acquireNativeAxisMaterial(
  env: Env,
  expectedFingerprint: string,
): Promise<NativeAxisCredentialMaterial> {
  if (!/^sha256:[0-9a-f]{64}$/.test(expectedFingerprint)) throw unavailable();
  const material = await captureNativeAxisMaterial(env);
  if (material.materialFingerprint !== expectedFingerprint) throw unavailable();
  return material;
}

function unavailable(): Error {
  return new Error("Native Axis credential material does not match its admitted binding");
}
