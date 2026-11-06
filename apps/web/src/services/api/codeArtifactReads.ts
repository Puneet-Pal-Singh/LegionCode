import { createHostedAppServerClient } from "./appServerClient.js";

/** The session identity is captured by the caller's loader closure. */
export async function loadCodeArtifactContent(
  sessionId: string,
  key: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await createHostedAppServerClient({
    signal,
    timeoutMs: null,
    maxResponseBytes: null,
  }).getCodeArtifactContent({ sessionId, key });
  return result.content;
}
