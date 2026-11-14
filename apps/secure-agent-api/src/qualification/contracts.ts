import { z } from "zod";
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
  action: z.enum(["reserve", "provision", "status", "retire"]),
  operationId: z.string().uuid(), scenario: z.literal("resource_provision"),
}).strict();
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
}).strict();
export type ResourceSetupBinding = z.infer<typeof ResourceSetupBindingSchema>;
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
export interface QualificationRecord {
  kind: "native_boundary_qualification";
  version: 1;
  subject: QualificationControlProps & { operationId: string };
  pins: QualificationPins;
  lease: QualificationLease;
  authorityDigest: string;
  token: string;
  phase: "reserved" | "starting" | "observed" | "provisioning" | "provisioned" | "retiring" | "retired" | "unknown";
  observation?: ResourceObservation;
  receipt?: ResourceProvisionReceipt;
  originalTransportSettled?: true;
  failureCode?: "QUALIFICATION_ORIGINAL_UNKNOWN";
  rawDispatched?: "observe" | "provision" | "retire";
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
