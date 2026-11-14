import type { NativeCheckoutBootstrapIntent, NativeCheckoutBootstrapReceipt } from "@repo/worker-protocol/private/native-checkout-bootstrap";
import { z } from "zod";
import { NativePhysicalIdentitySchema, NativePhysicalIntegerSchema, type NativeCommandClosure } from "@repo/shared-types/native-command-closure";
import type { ToolboxCommandResult } from "./ToolboxSession";
import type { GitRepositoryMetadataPaths } from "@repo/git-service";

const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,256}$/);
const nonce = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative().safe();
const physicalInteger = NativePhysicalIntegerSchema;
export const NativeCommandBindingSchema = z.object({
  executionDomainDigest: nonce,
  sessionId: id, leaseId: id, sandboxId: id, generation: integer, workspaceId: id,
  runId: id, threadId: id, turnId: id, runAttemptId: id, taskId: id, nonce,
}).strict();
export const NativeRootIdentitySchema = NativePhysicalIdentitySchema;
// CLI paths are not authority. The fixed held-FD backend validates their graph.
const metadataPaths = z.custom<GitRepositoryMetadataPaths>(value => value !== null && typeof value === "object");
export const NativeMetadataProtectionSchema = z.object({
  identity: z.string().regex(/^linux-git-metadata-v1:[a-f0-9]{64}$/),
  paths: metadataPaths,
  entries: z.array(z.object({
    path: z.string().regex(/^\/home\/sandbox\//).max(4096),
    device: physicalInteger, inode: physicalInteger.refine(value => value !== "0"), kind: z.enum(["directory", "file"]),
  }).strict()).min(1).max(32),
}).strict();
export const NativeWorkspaceStateSchema = z.object({
  root: NativeRootIdentitySchema, sandboxBootId: z.string().uuid(), metadata: NativeMetadataProtectionSchema,
}).strict();
export const NativeWorkspacePreparationSchema = NativeWorkspaceStateSchema.extend({ binding: NativeCommandBindingSchema });
export const NativeWorkspaceWriteReceiptSchema = z.object({
  binding: NativeCommandBindingSchema, root: NativeRootIdentitySchema, sandboxBootId: z.string().uuid(),
  metadataIdentity: z.string().regex(/^linux-git-metadata-v1:[a-f0-9]{64}$/),
  path: z.string().min(1).max(4096), file: NativeRootIdentitySchema,
  bytes: integer.max(200_000), sha256: nonce,
}).strict();
export const NativeCommandLimitsSchema = z.object({
  memoryBytes: integer.min(64 * 1024 * 1024).max(1024 * 1024 * 1024),
  pids: integer.min(16).max(256), cpuQuotaMicros: integer.min(10_000).max(100_000),
  cpuPeriodMicros: z.literal(100_000),
}).strict();
export const NativeCommandIdentitySchema = z.object({
  bootId: z.string().uuid(), namespaceDevice: physicalInteger, namespaceInode: physicalInteger.refine(value => value !== "0"),
  initHostPid: integer.positive(), root: NativeRootIdentitySchema,
  cgroup: NativeRootIdentitySchema, limits: NativeCommandLimitsSchema,
  metadataIdentity: z.string().min(1).max(512),
}).strict();
export const NativeCommandRequestSchema = z.object({
  version: z.literal(1), binding: NativeCommandBindingSchema, controlToken: nonce,
  root: z.string().regex(/^\/home\/sandbox\/checkouts\/[A-Za-z0-9_.-]+$/),
  expectedRoot: NativeRootIdentitySchema, cwd: z.string().min(1).max(4096),
  expectedBootId: z.string().uuid(),
  argv: z.array(z.string().max(8192)).min(1).max(1024),
  environment: z.record(z.enum(["NODE_ENV", "CI"]), z.string()),
  timeoutMs: integer.min(100).max(3_600_000), outputLimit: integer.min(1024).max(4 * 1024 * 1024),
  limits: NativeCommandLimitsSchema,
  metadata: NativeMetadataProtectionSchema,
}).strict();
export const NativeCommandReceiptSchema = z.object({
  version: z.literal(1), binding: NativeCommandBindingSchema,
  state: z.enum(["preparing", "prepared", "running", "stopping", "closed", "not_started", "unknown"]),
  identity: NativeCommandIdentitySchema.optional(), gateClosed: z.boolean(), admission: z.boolean(),
  exitCode: z.number().int().min(-1).max(255).optional(), reason: z.string().max(128).optional(),
  stdout: z.string().max(5_592_408).optional(), stderr: z.string().max(5_592_408).optional(),
  outputLimited: z.boolean(),
}).strict();
export type NativeCommandBinding = z.infer<typeof NativeCommandBindingSchema>;
export type NativeRootIdentity = z.infer<typeof NativeRootIdentitySchema>;
export type NativeWorkspacePreparation = z.infer<typeof NativeWorkspacePreparationSchema>;
export type NativeWorkspaceState = z.infer<typeof NativeWorkspaceStateSchema>;
export type NativeWorkspaceWriteReceipt = z.infer<typeof NativeWorkspaceWriteReceiptSchema>;
export type NativeMetadataProtection = z.infer<typeof NativeMetadataProtectionSchema>;
export type NativeCommandIdentity = z.infer<typeof NativeCommandIdentitySchema>;
export type NativeCommandRequest = z.infer<typeof NativeCommandRequestSchema>;
export type NativeCommandReceipt = z.infer<typeof NativeCommandReceiptSchema>;
export interface NativeCommandSpec {
  argv: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

/** Created inside the physical session owner, never decoded from tool payloads. */
export interface NativeCommandCapability {
  execute(spec: NativeCommandSpec): Promise<ToolboxCommandResult>;
  prepareWorkspace(metadataPaths: GitRepositoryMetadataPaths): Promise<NativeRootIdentity>;
  writeFile?(path: string, content: string, options?: { exclusive?: boolean }): Promise<void>;
  stop(): Promise<boolean>;
  awaitClosure(): Promise<boolean>;
  closureEvidence?(): Promise<NativeCommandClosure | undefined>;
}

export interface NativeCommandOriginal {
  stdout: string;
  stderr: string;
  exitCode: number;
}
export interface OwnedNativeSandboxPort {
  materializeNativeCheckout?(input: { physicalOwnerId: string; binding: NativeCommandBinding; intent: NativeCheckoutBootstrapIntent;
    authEnvironment?: Readonly<Record<string, string>> }): Promise<{ receipt: NativeCheckoutBootstrapReceipt; workspace: NativeWorkspaceState }>;
  executeNativeCommand(request: NativeCommandRequest): Promise<NativeCommandOriginal>;
  controlNativeCommand(request: {
    binding: NativeCommandBinding; controlToken: string;
    identity?: NativeCommandIdentity; action: "status" | "start" | "stop" | "ack";
  }): Promise<NativeCommandReceipt>;
  prepareNativeWorkspace(request: { binding: NativeCommandBinding; root: string; metadataPaths: GitRepositoryMetadataPaths }): Promise<NativeWorkspacePreparation>;
  writeNativeWorkspaceFile?(request: {
    binding: NativeCommandBinding; root: string; expectedRoot: NativeRootIdentity; expectedBootId: string;
    metadata: NativeMetadataProtection; path: string; content: string; exclusive: boolean;
  }): Promise<NativeWorkspaceWriteReceipt>;
}

export function sameNativeBinding(left: NativeCommandBinding, right: NativeCommandBinding): boolean {
  if (!NativeCommandBindingSchema.safeParse(left).success || !NativeCommandBindingSchema.safeParse(right).success) return false;
  return Object.keys(left).every(key => left[key as keyof NativeCommandBinding] === right[key as keyof NativeCommandBinding]);
}
export function sameNativeIdentity(left: NativeCommandIdentity, right: NativeCommandIdentity): boolean {
  if (!NativeCommandIdentitySchema.safeParse(left).success || !NativeCommandIdentitySchema.safeParse(right).success) return false;
  return left.bootId === right.bootId && left.namespaceDevice === right.namespaceDevice &&
    left.namespaceInode === right.namespaceInode && left.initHostPid === right.initHostPid &&
    left.root.device === right.root.device && left.root.inode === right.root.inode &&
    left.cgroup.device === right.cgroup.device && left.cgroup.inode === right.cgroup.inode &&
    left.metadataIdentity === right.metadataIdentity && JSON.stringify(left.limits) === JSON.stringify(right.limits);
}
