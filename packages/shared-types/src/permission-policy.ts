import { z } from "zod";
import { PRODUCT_MODES, type ProductMode } from "@repo/platform-protocol";
import {
  WORKFLOW_INTENTS,
  WORKFLOW_ENTRYPOINTS,
  WorkflowIntentSchema,
  WorkflowEntrypointSchema,
  type WorkflowIntent,
  type WorkflowEntrypoint,
} from "@repo/platform-protocol";
import type { RunMode } from "./run-mode.js";

export {
  PRODUCT_MODES,
  ProductModeSchema,
  WORKFLOW_INTENTS,
  WORKFLOW_ENTRYPOINTS,
  WorkflowIntentSchema,
  WorkflowEntrypointSchema,
} from "@repo/platform-protocol";
export type { ProductMode } from "@repo/platform-protocol";
export type { WorkflowIntent, WorkflowEntrypoint } from "@repo/platform-protocol";

export const APPROVAL_POLICIES = {
  ASK_ON_REQUEST: "ask_on_request",
  HIGH_TRUST: "high_trust",
  RESTRICTED: "restricted",
  CUSTOM: "custom",
} as const;

export const ApprovalPolicySchema = z.enum([
  APPROVAL_POLICIES.ASK_ON_REQUEST,
  APPROVAL_POLICIES.HIGH_TRUST,
  APPROVAL_POLICIES.RESTRICTED,
  APPROVAL_POLICIES.CUSTOM,
]);

export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;

export const EXECUTION_SCOPES = {
  WORKSPACE_SAFE: "workspace_safe",
  WORKSPACE_MUTATION: "workspace_mutation",
  WORKSPACE_HIGH_TRUST: "workspace_high_trust",
  CUSTOM: "custom",
} as const;

export const ExecutionScopeSchema = z.enum([
  EXECUTION_SCOPES.WORKSPACE_SAFE,
  EXECUTION_SCOPES.WORKSPACE_MUTATION,
  EXECUTION_SCOPES.WORKSPACE_HIGH_TRUST,
  EXECUTION_SCOPES.CUSTOM,
]);

export type ExecutionScope = z.infer<typeof ExecutionScopeSchema>;

export interface WorkflowIntentResolverInput {
  runMode: RunMode;
  entrypoint?: WorkflowEntrypoint;
  explicitIntent?: WorkflowIntent;
}

export interface PermissionTuple {
  approvalPolicy: ApprovalPolicy;
  executionScope: ExecutionScope;
}

export interface EffectivePermissionState extends PermissionTuple {
  productMode: ProductMode;
  workflowIntent: WorkflowIntent;
}

export const PERMISSION_RUNTIME_LABELS = {
  DEFAULT: "Default permissions",
  FULL_ACCESS: "Full access",
  CUSTOM: "Custom",
} as const;

export type PermissionRuntimeLabel =
  (typeof PERMISSION_RUNTIME_LABELS)[keyof typeof PERMISSION_RUNTIME_LABELS];

export const DEFAULT_PRODUCT_MODE: ProductMode = PRODUCT_MODES.AUTO_FOR_SAFE;

const DEFAULT_PERMISSION_TUPLE: PermissionTuple = {
  approvalPolicy: APPROVAL_POLICIES.ASK_ON_REQUEST,
  executionScope: EXECUTION_SCOPES.WORKSPACE_SAFE,
};

const FULL_ACCESS_PERMISSION_TUPLE: PermissionTuple = {
  approvalPolicy: APPROVAL_POLICIES.HIGH_TRUST,
  executionScope: EXECUTION_SCOPES.WORKSPACE_HIGH_TRUST,
};

const PRODUCT_MODE_TUPLE_MAP: Record<ProductMode, PermissionTuple> = {
  [PRODUCT_MODES.ASK_ALWAYS]: {
    approvalPolicy: APPROVAL_POLICIES.RESTRICTED,
    executionScope: EXECUTION_SCOPES.WORKSPACE_SAFE,
  },
  [PRODUCT_MODES.AUTO_FOR_SAFE]: DEFAULT_PERMISSION_TUPLE,
  [PRODUCT_MODES.AUTO_FOR_SAME_REPO]: {
    approvalPolicy: APPROVAL_POLICIES.ASK_ON_REQUEST,
    executionScope: EXECUTION_SCOPES.WORKSPACE_MUTATION,
  },
  [PRODUCT_MODES.FULL_AGENT]: FULL_ACCESS_PERMISSION_TUPLE,
};

const ENTRYPOINT_INTENT_MAP: Record<WorkflowEntrypoint, WorkflowIntent> = {
  [WORKFLOW_ENTRYPOINTS.COMPOSER_SUBMIT]: WORKFLOW_INTENTS.BUILD,
  [WORKFLOW_ENTRYPOINTS.REVIEW_ACTION]: WORKFLOW_INTENTS.REVIEW,
  [WORKFLOW_ENTRYPOINTS.COMMIT_ACTION]: WORKFLOW_INTENTS.SHIP,
  [WORKFLOW_ENTRYPOINTS.DEPLOY_ACTION]: WORKFLOW_INTENTS.SHIP,
  [WORKFLOW_ENTRYPOINTS.PROVIDER_CONNECT]: WORKFLOW_INTENTS.BUILD,
  [WORKFLOW_ENTRYPOINTS.OTHER]: WORKFLOW_INTENTS.BUILD,
};

export function resolveWorkflowIntent(
  input: WorkflowIntentResolverInput,
): WorkflowIntent {
  if (input.explicitIntent) {
    return input.explicitIntent;
  }

  if (input.entrypoint) {
    return ENTRYPOINT_INTENT_MAP[input.entrypoint];
  }

  if (input.runMode === "plan") {
    return WORKFLOW_INTENTS.REVIEW;
  }

  return WORKFLOW_INTENTS.BUILD;
}

export function mapProductModeToPermissionTuple(
  productMode: ProductMode,
): PermissionTuple {
  const tuple = PRODUCT_MODE_TUPLE_MAP[productMode];
  return {
    approvalPolicy: tuple.approvalPolicy,
    executionScope: tuple.executionScope,
  };
}

export function createEffectivePermissionState(input: {
  productMode: ProductMode;
  workflowIntent: WorkflowIntent;
}): EffectivePermissionState {
  const tuple = mapProductModeToPermissionTuple(input.productMode);
  return {
    productMode: input.productMode,
    workflowIntent: input.workflowIntent,
    approvalPolicy: tuple.approvalPolicy,
    executionScope: tuple.executionScope,
  };
}

export function derivePermissionLabel(
  state: EffectivePermissionState,
): PermissionRuntimeLabel {
  if (
    state.approvalPolicy === DEFAULT_PERMISSION_TUPLE.approvalPolicy &&
    state.executionScope === DEFAULT_PERMISSION_TUPLE.executionScope
  ) {
    return PERMISSION_RUNTIME_LABELS.DEFAULT;
  }

  if (
    state.approvalPolicy === FULL_ACCESS_PERMISSION_TUPLE.approvalPolicy &&
    state.executionScope === FULL_ACCESS_PERMISSION_TUPLE.executionScope
  ) {
    return PERMISSION_RUNTIME_LABELS.FULL_ACCESS;
  }

  return PERMISSION_RUNTIME_LABELS.CUSTOM;
}
