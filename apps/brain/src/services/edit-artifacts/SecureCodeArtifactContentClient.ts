import type { Env } from "../../types/ai";

export class SecureCodeArtifactContentNotFoundError extends Error {}

/** Reads existing R2 bytes only through Secure's internal service binding. */
export async function readSecureCodeArtifactContent(
  env: Env,
  key: string,
): Promise<string> {
  const secret = env.INTERNAL_RUNTIME_EVENT_SECRET;
  if (!secret) {
    throw new Error("Internal runtime service authentication is unavailable");
  }

  const response = await env.SECURE_API.fetch(
    "http://internal/api/v1/internal/artifact/content",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Runtime-Secret": secret,
      },
      body: JSON.stringify({ key }),
    },
  );
  if (response.status === 404) {
    throw new SecureCodeArtifactContentNotFoundError();
  }
  if (!response.ok) {
    throw new Error("Secure artifact storage is unavailable");
  }

  const result: unknown = await response.json().catch(() => null);
  if (
    !result ||
    typeof result !== "object" ||
    !("content" in result) ||
    typeof result.content !== "string"
  ) {
    throw new Error("Secure artifact storage returned an invalid response");
  }
  return result.content;
}
