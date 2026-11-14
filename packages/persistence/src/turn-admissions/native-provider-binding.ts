import { z } from "zod";
import {
  CredentialAcquisitionSchema,
  ProviderIdSchema,
} from "@repo/shared-types";
import type { SqlClient } from "../sql.js";

const Reference = z.string().min(1).max(256);

/** Private admission metadata. No secret material or client-owned selection. */
export const NativeProviderBindingScopeSchema = z.object({
  userId: Reference,
  workspaceId: Reference,
  sessionId: Reference,
  threadId: Reference,
  runId: Reference,
  turnId: Reference,
  runAttemptId: Reference,
}).strict();
export type NativeProviderBindingScope = z.infer<
  typeof NativeProviderBindingScopeSchema
>;

export const NativeProviderBindingSchema = z.discriminatedUnion("kind", [
  z.object({
    v: z.literal(1),
    kind: z.literal("byok"),
    scope: NativeProviderBindingScopeSchema,
    providerId: ProviderIdSchema,
    modelId: Reference,
    credential: CredentialAcquisitionSchema,
  }).strict(),
  z.object({
    v: z.literal(1),
    kind: z.literal("platform_managed_axis"),
    scope: NativeProviderBindingScopeSchema,
    providerId: z.literal("axis"),
    modelId: Reference,
    materialFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict(),
]).superRefine((binding, context) => {
  if (binding.kind !== "byok") return;
  if (binding.providerId === "axis") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["providerId"],
      message: "Axis requires its platform-managed binding",
    });
  }
  if (binding.credential.userId !== binding.scope.userId ||
      binding.credential.providerId !== binding.providerId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["credential"],
      message: "Credential ownership must match the admitted provider scope",
    });
  }
});
export type NativeProviderBinding = z.infer<typeof NativeProviderBindingSchema>;

export const NativeProviderAdmissionRouteSchema = z.enum(["native", "delegated"]);
export type NativeProviderAdmissionRoute = z.infer<
  typeof NativeProviderAdmissionRouteSchema
>;

export interface NativeProviderAdmissionCaptureInput {
  readonly scope: NativeProviderBindingScope;
  readonly executionRoute: NativeProviderAdmissionRoute;
  readonly providerId?: string | null;
  readonly modelId?: string | null;
}

/** The admission owner commits through the same bound transaction client. */
export interface NativeProviderAdmissionCapture {
  withBinding<T>(
    client: SqlClient,
    input: NativeProviderAdmissionCaptureInput,
    commit: (
      boundClient: SqlClient,
      binding: NativeProviderBinding | null,
    ) => Promise<T>,
  ): Promise<T>;
}

const scopeFields = NativeProviderBindingScopeSchema.keyof().options;

/** Missing, malformed or foreign metadata never selects current defaults. */
export function parseNativeProviderBindingForAdmission(
  value: unknown,
  expectedScope: NativeProviderBindingScope,
): NativeProviderBinding {
  const expected = NativeProviderBindingScopeSchema.parse(expectedScope);
  const binding = NativeProviderBindingSchema.parse(value);
  if (scopeFields.some((field) => binding.scope[field] !== expected[field])) {
    throw new Error("Native provider binding does not match its admission scope");
  }
  return binding;
}
