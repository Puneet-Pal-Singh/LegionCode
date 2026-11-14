import type { PlatformEvent } from "@repo/platform-protocol";
import { createStableEventFingerprint } from "./fingerprint.js";

export function platformFingerprint(event: PlatformEvent): string {
  const storeOwnedFields = new Set(["eventId", "sequence", "cursor", "createdAt"]);
  const input = Object.fromEntries(Object.entries(event).filter(([key]) => !storeOwnedFields.has(key)));
  return createStableEventFingerprint(input);
}
