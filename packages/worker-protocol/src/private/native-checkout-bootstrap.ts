import { z } from "zod";
import { NativeSandboxPhysicalBindingSchema } from "./native-sandbox-binding.js";
import { ExecutionDomainDigestSchema } from "./execution-domain.js";

const sha = ExecutionDomainDigestSchema;
const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,256}$/);
const artifactId = z.string().regex(/^artifacts\/[A-Za-z0-9_.:-]+\/[A-Za-z0-9_.:-]+$/).max(1024);
const objectId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const physical = z.object({ device: z.string().regex(/^[0-9]{1,20}$/), inode: z.string().regex(/^[1-9][0-9]{0,19}$/) }).strict();
export const NativeCheckoutBootstrapIntentSchema = z.object({
  version: z.literal(1), checkoutId: id, snapshotId: id,
  repositoryUrl: z.string().url().max(2048).refine(value => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  }),
  authorizedCommitId: objectId, authorizedTreeId: objectId,
  workingBranch: z.string().regex(/^task\/[A-Za-z0-9_.-]+$/),
  root: z.string().regex(/^\/home\/sandbox\/checkouts\/[A-Za-z0-9_.-]+$/),
}).strict().superRefine((value, context) => {
  if (value.root !== `/home/sandbox/checkouts/${value.checkoutId}` || value.workingBranch !== `task/${value.checkoutId}`)
    context.addIssue({ code: "custom", message: "Checkout bootstrap paths do not match its owner" });
});
export type NativeCheckoutBootstrapIntent = z.infer<typeof NativeCheckoutBootstrapIntentSchema>;
export const NativeBootstrapBindingSchema = z.object({
  executionDomainDigest: sha, sessionId: id, leaseId: id, sandboxId: id,
  generation: z.number().int().nonnegative().safe(), workspaceId: id, runId: id,
  threadId: id, turnId: id, runAttemptId: id, taskId: id, nonce: sha,
}).strict();
export const NativeBootstrapObservationSchema = z.object({
  binding: NativeBootstrapBindingSchema, root: physical, sandboxBootId: z.string().uuid(),
  helperSha256: sha, kernelRelease: z.string().min(1).max(256),
}).strict();
export const NativeBootstrapWitnessSchema = z.object({
  version: z.literal(2), binding: NativeBootstrapBindingSchema,
  workspaceRoot: physical, sandboxBootId: z.string().uuid(), metadataIdentity: z.string().regex(/^linux-git-metadata-v1:[a-f0-9]{64}$/),
  storageRoot: physical, key: z.string().regex(/^bootstrap-[a-f0-9]{64}\.json$/), file: physical,
  bytes: z.number().int().positive().max(200_000), sha256: sha, materializationSha256: sha,
}).strict();
export const NativeCheckoutBootstrapReceiptSchema = z.object({
  version: z.literal(2), physicalBinding: NativeSandboxPhysicalBindingSchema, intent: NativeCheckoutBootstrapIntentSchema,
  observation: NativeBootstrapObservationSchema,
  metadataIdentity: z.string().regex(/^linux-git-metadata-v1:[a-f0-9]{64}$/),
  head: objectId, tree: objectId, branch: z.string().regex(/^task\/[A-Za-z0-9_.-]+$/),
  witness: NativeBootstrapWitnessSchema,
  git: z.array(z.object({ commandSha256: sha, originalTransportSettled: z.literal(true) }).strict()).min(1).max(64),
  // This receipt is emitted only after all original Git/helper transports drain.
  originalTransportSettled: z.literal(true),
}).strict().superRefine((value, context) => {
  const observed = value.observation, witness = value.witness;
  if (witness.key !== `bootstrap-${observed.binding.nonce}.json` || JSON.stringify(witness.binding) !== JSON.stringify(observed.binding) ||
    witness.workspaceRoot.device !== observed.root.device || witness.workspaceRoot.inode !== observed.root.inode ||
    witness.sandboxBootId !== observed.sandboxBootId || witness.metadataIdentity !== value.metadataIdentity ||
    value.head !== value.intent.authorizedCommitId || value.tree !== value.intent.authorizedTreeId || value.branch !== value.intent.workingBranch)
    context.addIssue({ code: "custom", message: "Bootstrap witness does not match original materialization" });
});
export type NativeCheckoutBootstrapReceipt = z.infer<typeof NativeCheckoutBootstrapReceiptSchema>;

/** Physical materialization is not image/platform qualification. Only the
 * existing physical owner's trusted image/platform producer may attach this
 * evidence; request metadata, expected pins and operator receipts cannot do so. */
export const NativeCheckoutReadyEvidenceSchema = z.object({
  bootstrap: NativeCheckoutBootstrapReceiptSchema,
  artifact: z.object({ id: artifactId, sha256: sha, size: z.number().int().positive().safe() }).strict(),
  runtime: z.object({
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/), helperSha256: sha, policySha256: sha,
    physicalBinding: NativeSandboxPhysicalBindingSchema,
    binding: NativeBootstrapBindingSchema, commandBinding: NativeBootstrapBindingSchema,
    resourceArtifactId: artifactId, resourceSha256: sha, commandArtifactId: artifactId, commandSha256: sha,
    sandboxBootId: z.string().uuid(), kernelRelease: z.string().min(1).max(256),
    executionDomainDigest: sha, sessionId: id, leaseId: id, sandboxId: id,
    generation: z.number().int().nonnegative().safe(),
    // Immutable evidence from the physical authority, not a qualification flag.
    receiptArtifactId: artifactId, receiptSha256: sha,
    root: physical, metadataIdentity: z.string().regex(/^linux-git-metadata-v1:[a-f0-9]{64}$/),
    namespace: z.object({ device: z.string().regex(/^[0-9]{1,20}$/), inode: z.string().regex(/^[1-9][0-9]{0,19}$/),
      initHostPid: z.number().int().positive().safe() }).strict(),
    cgroup: physical,
    limits: z.object({ memoryBytes: z.literal(536870912), pids: z.literal(128),
      cpuQuotaMicros: z.literal(100000), cpuPeriodMicros: z.literal(100000) }).strict(),
  }).strict(),
}).strict();
export type NativeCheckoutReadyEvidence = z.infer<typeof NativeCheckoutReadyEvidenceSchema>;
/** Actual observations remain nonqualifying until a trusted deployment/source
 * owner joins them. A provider START reference is deliberately named as such. */
export const NativeRuntimeObservationSchema = NativeCheckoutReadyEvidenceSchema.shape.runtime.omit({
  imageDigest: true, policySha256: true, receiptArtifactId: true, receiptSha256: true,
}).extend({ observedPolicySha256: sha, sandboxObjectId: z.string().regex(/^[a-f0-9]{64}$/), providerImageReference: z.string().min(1).max(2048),
  providerImageDigestReference: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict();
export type NativeRuntimeObservation = z.infer<typeof NativeRuntimeObservationSchema>;

export function freezeBootstrap<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freezeBootstrap(child); Object.freeze(value); }
  return value;
}

export function parseNativeCheckoutReadyEvidence(value: unknown): NativeCheckoutReadyEvidence {
  const evidence = NativeCheckoutReadyEvidenceSchema.parse(value);
  const { bootstrap, runtime } = evidence;
  const observed = bootstrap.observation, binding = observed.binding;
  if (JSON.stringify(runtime.physicalBinding) !== JSON.stringify(bootstrap.physicalBinding) || bootstrap.witness.key !== `bootstrap-${binding.nonce}.json` || JSON.stringify(bootstrap.witness.binding) !== JSON.stringify(binding) ||
    bootstrap.witness.sandboxBootId !== observed.sandboxBootId || bootstrap.witness.workspaceRoot.device !== observed.root.device ||
    bootstrap.witness.workspaceRoot.inode !== observed.root.inode || bootstrap.witness.metadataIdentity !== bootstrap.metadataIdentity || bootstrap.head !== bootstrap.intent.authorizedCommitId || bootstrap.tree !== bootstrap.intent.authorizedTreeId ||
    bootstrap.branch !== bootstrap.intent.workingBranch || JSON.stringify(runtime.binding) !== JSON.stringify(binding) ||
    JSON.stringify({ ...runtime.commandBinding, nonce: binding.nonce }) !== JSON.stringify(binding) ||
    !runtime.resourceArtifactId.startsWith(`artifacts/${binding.sessionId}/`) || !runtime.commandArtifactId.startsWith(`artifacts/${binding.sessionId}/`) || runtime.helperSha256 !== observed.helperSha256 ||
    runtime.kernelRelease !== observed.kernelRelease || runtime.sandboxBootId !== observed.sandboxBootId ||
    runtime.executionDomainDigest !== binding.executionDomainDigest || runtime.sessionId !== binding.sessionId ||
    runtime.leaseId !== binding.leaseId || runtime.sandboxId !== binding.sandboxId || runtime.generation !== binding.generation || runtime.root.device !== observed.root.device || runtime.root.inode !== observed.root.inode ||
    runtime.metadataIdentity !== bootstrap.metadataIdentity || !evidence.artifact.id.startsWith(`artifacts/${binding.sessionId}/`) ||
    !runtime.receiptArtifactId.startsWith(`artifacts/${binding.sessionId}/`))
    throw new Error("NATIVE_BOOTSTRAP_PROVENANCE_MISMATCH");
  return freezeBootstrap(evidence);
}
