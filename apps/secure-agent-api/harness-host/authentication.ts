import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  HarnessStartCommandSchema,
  type HarnessStartCommand,
} from "@repo/worker-protocol";
import type { CloudHarnessComposition } from "./composition";

export interface CloudHarnessAuthenticatedContext {
  readonly command: HarnessStartCommand;
  readonly composition: CloudHarnessComposition;
}

/** Trusted per-lease setup only. This is an ephemeral bridge credential, never
 * a provider password/token. Its durable owner must rotate/fence on replacement.
 */
export function createCloudHarnessAuthenticator(grant: {
  readonly credential: string;
  readonly command: HarnessStartCommand;
  readonly expiresAt: number;
  readonly composition: CloudHarnessComposition;
}): (request: IncomingMessage) => Promise<CloudHarnessAuthenticatedContext> {
  if (
    !/^[A-Za-z0-9_-]{43,256}$/.test(grant.credential) ||
    !Number.isSafeInteger(grant.expiresAt) ||
    grant.expiresAt <= 0
  )
    throw new Error("Invalid cloud harness bridge grant");
  let command: HarnessStartCommand;
  try {
    command = HarnessStartCommandSchema.parse(grant.command);
  } catch {
    throw new Error("Invalid cloud harness bridge grant");
  }
  const expiresAt = grant.expiresAt;
  const composition = grant.composition;
  const fingerprint = createHash("sha256").update(grant.credential).digest();
  return async (request) => {
    const header = request.headers.authorization;
    const token =
      typeof header === "string" && header.startsWith("Bearer ")
        ? header.slice(7)
        : "";
    const candidate = createHash("sha256").update(token).digest();
    if (
      request.url !== "/bridge" ||
      request.headers.origin ||
      Date.now() >= expiresAt ||
      !timingSafeEqual(fingerprint, candidate)
    )
      throw new Error("Cloud harness bridge authorization failed");
    try {
      await composition.assertActive({ command });
    } catch {
      throw new Error("Cloud harness bridge authorization failed");
    }
    return { command, composition };
  };
}
