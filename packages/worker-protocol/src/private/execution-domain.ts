import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,256}$/);
export const ExecutionDomainDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const ExecutionDomainScopeSchema = z.object({
  userId: id, brainSessionId: id, workspaceId: id, threadId: id,
  turnId: id, runId: id, runAttemptId: id,
}).strict();
export const ServerExecutionDomainBindingSchema = z.discriminatedUnion("domain", [
  z.object({ version: z.literal(1), domain: z.literal("legioncode_native"), scope: ExecutionDomainScopeSchema }).strict(),
  z.object({ version: z.literal(1), domain: z.literal("delegated_harness"), scope: ExecutionDomainScopeSchema,
    // Only the frozen delegated-route owner produces this digest from all pins.
    delegatedRouteDigest: ExecutionDomainDigestSchema,
  }).strict(),
]);
export type ServerExecutionDomainBinding = z.infer<typeof ServerExecutionDomainBindingSchema>;

/** Private server admission data. A digest identifies this snapshot; it is not
 * authentication and cannot replace the existing service-secret/bearer boundary. */
export function snapshotExecutionDomain(value: unknown): ServerExecutionDomainBinding {
  const parsed = ServerExecutionDomainBindingSchema.parse(value);
  Object.freeze(parsed.scope);
  return Object.freeze(parsed);
}
export function serializeExecutionDomain(value: ServerExecutionDomainBinding): string {
  const binding = snapshotExecutionDomain(value);
  const scope = binding.scope;
  const common = { version: binding.version, domain: binding.domain,
    scope: { userId: scope.userId, brainSessionId: scope.brainSessionId, workspaceId: scope.workspaceId,
      threadId: scope.threadId, turnId: scope.turnId, runId: scope.runId, runAttemptId: scope.runAttemptId } };
  return JSON.stringify(binding.domain === "delegated_harness" ? { ...common, delegatedRouteDigest: binding.delegatedRouteDigest } : common);
}
export async function executionDomainDigest(value: ServerExecutionDomainBinding): Promise<string> {
  const bytes = new TextEncoder().encode(serializeExecutionDomain(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
export function sameExecutionDomain(left: ServerExecutionDomainBinding, right: ServerExecutionDomainBinding): boolean {
  return serializeExecutionDomain(left) === serializeExecutionDomain(right);
}
