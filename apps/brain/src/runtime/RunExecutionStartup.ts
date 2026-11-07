import type { TurnId } from "@repo/platform-protocol";
import type { RunInterruptRegistry } from "./RunInterruptRegistry";

/** Register the local startup owner before durable claim I/O yields. A queued
 * Stop remains latched until the claimed runner takes ownership. */
export async function claimExecutionWithStartupInterrupt<
  T extends { readonly status: string },
>(
  registry: RunInterruptRegistry,
  turnId: TurnId,
  claim: () => Promise<T>,
): Promise<T> {
  const ownsStartup = !registry.hasActiveOwner(turnId);
  if (ownsStartup) registry.beginStartup(turnId);
  try {
    const result = await claim();
    if (result.status !== "claimed" && ownsStartup) registry.unregister(turnId);
    return result;
  } catch (error) {
    if (ownsStartup) registry.unregister(turnId);
    throw error;
  }
}
