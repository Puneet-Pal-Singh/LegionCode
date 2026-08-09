import {
  ApprovalPolicySchema,
  ExecutionScopeSchema,
  PERMISSION_RUNTIME_LABELS,
  ProductModeSchema,
  RunModeSchema,
  WorkflowEntrypointSchema,
  WorkflowIntentSchema,
} from "@repo/shared-types";
import { z } from "zod";
import type { Run } from "../run/index.js";

const PersistedPermissionContextSchema = z
  .object({
    state: z
      .object({
        productMode: ProductModeSchema,
        workflowIntent: WorkflowIntentSchema,
        approvalPolicy: ApprovalPolicySchema,
        executionScope: ExecutionScopeSchema,
      })
      .strict(),
    label: z.enum([
      PERMISSION_RUNTIME_LABELS.DEFAULT,
      PERMISSION_RUNTIME_LABELS.FULL_ACCESS,
      PERMISSION_RUNTIME_LABELS.CUSTOM,
    ]),
    resolverInput: z
      .object({
        runMode: RunModeSchema,
        entrypoint: WorkflowEntrypointSchema.optional(),
        explicitIntent: WorkflowIntentSchema.optional(),
      })
      .strict(),
    resolvedAt: z.string().datetime(),
  })
  .strict();

export function requirePersistedPermissionContext(
  run: Run,
): NonNullable<Run["metadata"]["permissionContext"]> {
  const permissionContext = run.metadata.permissionContext;
  if (!permissionContext) {
    throw new Error(
      `[runtime-kernel/native] Run ${run.id} is missing persisted permission context`,
    );
  }

  const parsed = PersistedPermissionContextSchema.safeParse(permissionContext);
  if (!parsed.success) {
    throw new Error(
      `[runtime-kernel/native] Run ${run.id} has malformed persisted permission context`,
    );
  }

  return parsed.data;
}
