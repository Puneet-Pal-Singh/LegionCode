import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,256}$/);
const hex = z.string().regex(/^[a-f0-9]{64}$/);
/** Kernel device/inode values never pass through a JavaScript number. */
export const NativePhysicalIntegerSchema = z.string().regex(/^(?:0|[1-9][0-9]{0,19})$/)
  .refine(value => { try { return BigInt(value) <= 18_446_744_073_709_551_615n; } catch { return false; } });
export const NativePhysicalIdentitySchema = z.object({
  device: NativePhysicalIntegerSchema,
  inode: NativePhysicalIntegerSchema.refine(value => value !== "0"),
}).strict();

export const NativeCommandScopeSchema = z.object({
  executionDomainDigest: hex,
  sessionId: id, leaseId: id, sandboxId: id, generation: z.number().int().nonnegative().safe(),
  workspaceId: id, workspaceRoot: z.string().regex(/^\/home\/sandbox\/checkouts\/[A-Za-z0-9_.-]+$/),
  runId: id, threadId: id, turnId: id, runAttemptId: id, taskId: id,
}).strict();

/** Private physical-owner evidence, not a lifecycle item or renderer/tool DTO.
 * Server transport settlement does not prove the caller's HTTP body settled. */
export const NativeCommandClosureSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("unknown"), scope: NativeCommandScopeSchema,
    operationId: id, originalTransportSettled: z.literal(false),
  }).strict(),
  z.object({
    state: z.literal("settled"), scope: NativeCommandScopeSchema,
    profile: z.literal("linux-pid-namespace-cgroup-v2"),
    operationId: hex, nonce: hex, originalTransportSettled: z.literal(true),
    root: NativePhysicalIdentitySchema, sandboxBootId: z.string().uuid(),
    namespace: z.object({
      device: NativePhysicalIntegerSchema,
      inode: NativePhysicalIntegerSchema.refine(value => value !== "0"),
      initHostPid: z.number().int().positive().safe(),
    }).strict(),
    cgroup: NativePhysicalIdentitySchema, metadataIdentity: z.string().regex(/^linux-git-metadata-v1:[a-f0-9]{64}$/),
    receiptSha256: hex,
  }).strict(),
]).refine(value => value.state !== "settled" || value.operationId === value.nonce);
export type NativeCommandClosure = z.infer<typeof NativeCommandClosureSchema>;
export type NativeCommandScope = z.infer<typeof NativeCommandScopeSchema>;

export function matchesNativeCommandScope(actual: NativeCommandScope, expected: NativeCommandScope): boolean {
  return Object.keys(expected).every(key => actual[key as keyof NativeCommandScope] === expected[key as keyof NativeCommandScope]);
}

export function parseNativeCommandClosure(value: unknown, expected: NativeCommandScope): NativeCommandClosure | null {
  const parsed = NativeCommandClosureSchema.safeParse(value);
  if (!parsed.success || !matchesNativeCommandScope(parsed.data.scope, expected)) return null;
  return parsed.data;
}
