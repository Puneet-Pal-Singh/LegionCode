import { z } from "zod";
import { NativeBootstrapBindingSchema } from "@repo/worker-protocol/private/native-checkout-bootstrap";
import { NativeCommandReceiptSchema, NativeCommandIdentitySchema } from "../toolbox/contracts/OwnedSandboxCommand";
import { NativePhysicalIdentitySchema, NativePhysicalIntegerSchema } from "@repo/shared-types/native-command-closure";

export const QUALIFICATION_ENVIRONMENT = "native-boundary-qualification";
export const RESOURCE_POLICY = "linux-pid-namespace-cgroup-v2-512m-v1";
const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,256}$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const QualificationControlPropsSchema = z.object({
  purpose: z.literal("native_boundary_qualification"),
  operatorAccountId: z.string().regex(/^[a-f0-9]{32}$/), controlPrincipal: id,
  environmentId: z.string().uuid(), authorityReceiptSha256: sha,
}).strict();
export type QualificationControlProps = z.infer<typeof QualificationControlPropsSchema>;
export const QualificationPinsSchema = z.object({
  imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/), helperSha256: sha, policySha256: sha,
}).strict();
export type QualificationPins = z.infer<typeof QualificationPinsSchema>;
export const QualificationCommandSchema = z.object({
  action: z.enum(["reserve", "provision", "status", "retire", "qualify", "stop"]),
  operationId: z.string().uuid(), scenario: z.enum(["resource_provision", "namespace_subprocess_stop"]),
}).strict().refine(value => (value.action === "qualify" || value.action === "stop")
  ? value.scenario === "namespace_subprocess_stop" : value.scenario === "resource_provision");
export type QualificationCommand = z.infer<typeof QualificationCommandSchema>;
export const QualificationLeaseSchema = z.object({
  sessionId: id, leaseId: id, sandboxId: id, sandboxObjectId: z.string().regex(/^[a-f0-9]{64}$/),
  ownerId: z.string().regex(/^[a-f0-9]{64}$/), physicalAttemptKey: id, generation: z.literal(0),
  expiresAt: z.number().int().positive().safe(),
}).strict();
export type QualificationLease = z.infer<typeof QualificationLeaseSchema>;
export const ResourceSetupBindingSchema = z.object({
  purpose: z.literal("native_boundary_qualification"), operatorAccountId: z.string().regex(/^[a-f0-9]{32}$/),
  controlPrincipal: id, environmentId: z.string().uuid(), operationId: z.string().uuid(),
  sessionId: id, leaseId: id, sandboxId: id, generation: z.literal(0),
  physicalOwnerId: id, physicalAttemptKey: id,
  authorityDigest: sha, parentAuthorityDigest: sha, physicalOwnerAuditHash: sha,
  expiresAt: z.number().int().positive().safe(),
}).strict();
export type ResourceSetupBinding = z.infer<typeof ResourceSetupBindingSchema>;
// Real product admission remains distinct from operator authority.
export const NativeResourceSetupBindingSchema = z.object({ purpose: z.literal("legioncode_native"),
  native: NativeBootstrapBindingSchema, physicalOwnerId: id, expiresAt: z.number().int().positive().safe() }).strict();

export const ResourceObservationInputSchema = z.object({ version: z.literal(1),
  binding: ResourceSetupBindingSchema, policy: z.literal(RESOURCE_POLICY) }).strict();
export const ResourceProvisionInputSchema = ResourceObservationInputSchema.extend({
  expectedBootId: z.string().uuid(), expectedParent: NativePhysicalIdentitySchema,
}).strict();
const cgroupObservation = z.object({
  identity: NativePhysicalIdentitySchema, values: z.record(z.string().max(1024)),
}).strict();
export const ResourceObservationSchema = z.object({
  version: z.literal(1), operation: z.literal("resource_observation"), binding: ResourceSetupBindingSchema,
  policy: z.literal(RESOURCE_POLICY), sandboxBootId: z.string().uuid(), parent: cgroupObservation,
  memTotal: NativePhysicalIntegerSchema, memAvailable: NativePhysicalIntegerSchema, helperSha256: sha,
}).strict();
export type ResourceObservation = z.infer<typeof ResourceObservationSchema>;
export const ResourceProvisionReceiptSchema = z.object({
  version: z.literal(1), operation: z.literal("resource_provision"), binding: ResourceSetupBindingSchema,
  policy: z.literal(RESOURCE_POLICY), sandboxBootId: z.string().uuid(), parent: cgroupObservation,
  boundary: cgroupObservation, control: cgroupObservation, commands: cgroupObservation,
  memTotal: NativePhysicalIntegerSchema, memAvailable: NativePhysicalIntegerSchema,
  siblingProtectedBytes: NativePhysicalIntegerSchema,
}).strict();
export type ResourceProvisionReceipt = z.infer<typeof ResourceProvisionReceiptSchema>;
export const NativeResourceObservationSchema = ResourceObservationSchema.extend({ binding: NativeResourceSetupBindingSchema });
export const NativeResourceProvisionReceiptSchema = ResourceProvisionReceiptSchema.extend({ binding: NativeResourceSetupBindingSchema });
export const NativeRuntimePreparationSchema = z.object({
  imageReference: z.string().min(1).max(2048), imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  sandboxObjectId: z.string().regex(/^[a-f0-9]{64}$/),
  observation: NativeResourceObservationSchema, resources: NativeResourceProvisionReceiptSchema,
}).strict();
export type NativeRuntimePreparation = z.infer<typeof NativeRuntimePreparationSchema>;

export const QualificationFixtureSchema = z.object({
  root: z.string().regex(/^\/home\/sandbox\/checkouts\/operator-qualification-[a-f0-9]{64}$/),
  identity: NativePhysicalIdentitySchema, sandboxBootId: z.string().uuid(),
  fingerprint: z.string().regex(/^native-qualification-fixture-v1:[a-f0-9]{64}$/), helperSha256: sha,
}).strict();
export type QualificationFixture = z.infer<typeof QualificationFixtureSchema>;
export const QualificationNamespaceBindingSchema = z.object({ qualification: ResourceSetupBindingSchema, nonce: sha }).strict();
export const QualificationNamespaceReceiptSchema = NativeCommandReceiptSchema.extend({ binding: QualificationNamespaceBindingSchema });
export type QualificationNamespaceReceipt = z.infer<typeof QualificationNamespaceReceiptSchema>;
export const QualificationNamespaceInputSchema = z.object({ binding: ResourceSetupBindingSchema, nonce: sha,
  fixture: QualificationFixtureSchema.optional(), controlToken: sha.optional() }).strict();
export const QualificationMarkersSchema = z.object({ binding: ResourceSetupBindingSchema, nonce: sha,
  fixture: QualificationFixtureSchema, stableIntervalMs: z.number().int().min(250).max(60_000).safe(),
  markers: z.array(z.object({ name: z.enum(["detached", "double-fork", "clone-parent"]),
    identity: NativePhysicalIdentitySchema, bytes: z.number().int().positive().max(16384), sha256: sha }).strict()).length(3),
}).strict();
export type QualificationMarkers = z.infer<typeof QualificationMarkersSchema>;
export type QualificationRawAction = "observe" | "provision" | "retire" | "fixture" | "namespace" | "verify";
export interface QualificationNamespaceIntent {
  nonce: string;
  controlToken: string;
  fixture?: QualificationFixture;
  identity?: z.infer<typeof NativeCommandIdentitySchema>;
  stopRequested?: true;
  stopControlSettled?: true;
  /** Durable creator seal; later Stop requests are read-only, never new loans. */
  controlAdmissionClosed?: true;
  payloadReady?: true;
  receipt?: QualificationNamespaceReceipt;
  receiptSha256?: string;
  originalTransportSettled?: true;
  markers?: QualificationMarkers;
}
export interface QualificationRecord {
  kind: "native_boundary_qualification";
  version: 1;
  subject: QualificationControlProps & { operationId: string };
  pins: QualificationPins;
  lease: QualificationLease;
  authorityDigest: string;
  token: string;
  phase: "reserved" | "starting" | "observed" | "provisioning" | "provisioned" | "retiring" | "retired" | "unknown" | "qualifying_fixture" | "qualifying_namespace" | "namespace_running" | "qualifying_verify" | "namespace_observed" | "namespace_closed";
  namespace?: QualificationNamespaceIntent;
  observation?: ResourceObservation;
  receipt?: ResourceProvisionReceipt;
  originalTransportSettled?: true;
  failureCode?: "QUALIFICATION_ORIGINAL_UNKNOWN" | "QUALIFICATION_RECIPE_INCOMPLETE";
  rawDispatched?: QualificationRawAction;
  originalId?: string;
}
export function isQualificationRecord(value: unknown): value is QualificationRecord {
  return value !== null && typeof value === "object" && "kind" in value && value.kind === "native_boundary_qualification";
}
export function freezeQualification<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeQualification(child);
    Object.freeze(value);
  }
  return value;
}
export async function qualificationDigest(value: unknown): Promise<string> {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item !== null && typeof item === "object") return Object.fromEntries(
      Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, child]) => [key, canonical(child)]));
    return item;
  };
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical(value))));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
export function qualificationToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
