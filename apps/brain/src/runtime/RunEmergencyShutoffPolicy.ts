import type { Env } from "../types/ai";

export function isRunAdmissionBlocked(
  env: Pick<Env, "LAUNCH_EMERGENCY_SHUTOFF_MODE">,
): boolean {
  return env.LAUNCH_EMERGENCY_SHUTOFF_MODE?.trim().toLowerCase() === "block_runs";
}
