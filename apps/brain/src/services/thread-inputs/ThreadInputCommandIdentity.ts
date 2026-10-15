import {
  RunIdSchema,
  RunAttemptIdSchema,
  TurnIdSchema,
} from "@repo/platform-protocol";

/** Stable identities make a retried command resume the same admitted execution. */
export async function createThreadInputCommandIdentity(seed: string): Promise<{
  runId: string;
  runAttemptId: string;
  turnId: string;
}> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed));
  const suffix = Array.from(new Uint8Array(digest).slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return {
    runId: RunIdSchema.parse(`run_${suffix}`),
    runAttemptId: RunAttemptIdSchema.parse(`attempt_${suffix}`),
    turnId: TurnIdSchema.parse(`trn_${suffix}`),
  };
}
