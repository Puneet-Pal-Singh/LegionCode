import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  HarnessStartCommandSchema,
  HarnessOpeningFenceTargetSchema, type HarnessOpeningFenceTarget,
  type HarnessStartCommand,
  type HarnessSession,
  HarnessSessionSchema,
} from "@repo/worker-protocol";
import type { CloudHarnessComposition } from "./composition";

export interface CloudHarnessAuthenticatedContext {
  readonly command: HarnessStartCommand;
  readonly composition: CloudHarnessComposition;
  readonly cleanupOnly: boolean;
  readonly cleanupSession?: HarnessSession;
  readonly cleanupOpening?: HarnessOpeningFenceTarget;
}

/** Trusted per-lease setup only. This is an ephemeral bridge credential, never
 * a provider password/token. Its durable owner must rotate/fence on replacement.
 */
export function createCloudHarnessAuthenticator(grant: {
  readonly credential: string;
  readonly command: HarnessStartCommand;
  readonly expiresAt: number;
  readonly composition: CloudHarnessComposition;
  /** Existing retained checkout bearer, bound here to the exact process/session.
   * This cleanup-only grant is independent of provider auth and distinct from
   * the active private Node bridge credential.
   */
  readonly cleanup?: {
    readonly credential: string;
    readonly expiresAt: number;
  } & ({readonly session: HarnessSession; readonly opening?: never} | {readonly opening: HarnessOpeningFenceTarget; readonly session?: never});

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
  const cleanup = grant.cleanup
    ? Object.freeze({
        ...grant.cleanup,
        ...(grant.cleanup.opening ? {opening: HarnessOpeningFenceTargetSchema.parse(grant.cleanup.opening)} :
          {session: HarnessSessionSchema.parse(grant.cleanup.session)}),
      })
    : undefined;
  if (
    cleanup &&
    (!/^[A-Za-z0-9_-]{43,256}$/.test(cleanup.credential) ||
      !Number.isSafeInteger(cleanup.expiresAt) ||
      cleanup.expiresAt <= 0 ||
      cleanup.credential === grant.credential ||
      (cleanup.opening ? cleanup.opening.runAttemptId !== command.selection.runAttemptId ||
        cleanup.opening.instanceId !== command.selection.instanceId || cleanup.opening.userId !== command.selection.userId ||
        cleanup.opening.workspaceId !== command.selection.workspaceId || cleanup.opening.environmentId !== command.selection.environmentId ||
        cleanup.opening.turnId !== command.selection.turnId || cleanup.opening.executionLease.leaseId !== command.leaseId ||
        cleanup.opening.commandFingerprint !== createHash("sha256").update(JSON.stringify(command)).digest("hex") ||
        cleanup.opening.openingRef !== `${command.selection.runAttemptId}:${cleanup.opening.processGeneration}` :
        !cleanup.session || cleanup.session.runAttemptId !== command.selection.runAttemptId || cleanup.session.instanceId !== command.selection.instanceId))
  )
    throw new Error("Invalid cloud harness cleanup grant");
  const fingerprint = createHash("sha256").update(grant.credential).digest();
  return async (request) => {
    const header = request.headers.authorization;
    const token =
      typeof header === "string" && header.startsWith("Bearer ")
        ? header.slice(7)
        : "";
    const candidate = createHash("sha256").update(token).digest();
    const cleanupOnly =
      request.headers["x-legion-harness-intent"] === "cleanup";
    const expected =
      cleanupOnly && cleanup
        ? createHash("sha256").update(cleanup.credential).digest()
        : fingerprint;
    if (
      (cleanupOnly && !cleanup) ||
      request.url !== "/bridge" ||
      request.headers.origin ||
      Date.now() >= (cleanupOnly && cleanup ? cleanup.expiresAt : expiresAt) ||
      !timingSafeEqual(expected, candidate)
    )
      throw new Error("Cloud harness bridge authorization failed");
    try {
      if (cleanupOnly && cleanup) {
        if (cleanup.opening) await composition.authorize({operation: "opening_fence", opening: cleanup.opening});
        else if (cleanup.session) await composition.authorize({operation: "cleanup_connect", session: cleanup.session});
        else throw new Error("Cleanup authority unavailable");
      }
      else await composition.authorize({ operation: "connect", command });
    } catch {
      throw new Error("Cloud harness bridge authorization failed");
    }
    return {
      command,
      composition,
      cleanupOnly,
      ...(cleanupOnly && cleanup ? cleanup.opening ? {cleanupOpening: cleanup.opening} : {cleanupSession: cleanup.session} : {}),
    };
  };
}
