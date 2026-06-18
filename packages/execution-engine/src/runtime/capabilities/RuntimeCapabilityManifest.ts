import { z } from "zod";
import {
  getCodingToolDefinitions,
  MAX_TOOL_READ_LINES,
  MAX_TOOL_SEARCH_RESULTS,
  MAX_TOOL_WRITE_CONTENT_LENGTH,
  ToolBackendCapabilitySchema,
  ToolParallelismSchema,
  ToolPermissionMetadataSchema,
  ToolRendererHintSchema,
  type ToolDefinition,
  type ToolPermissionPolicy,
  type ToolSandboxClass,
} from "../tools/CodingToolRegistry.js";

export const RuntimeToolSandboxClassSchema = z.enum([
  "read",
  "write",
  "shell",
  "network",
  "git",
  "approval",
  "browser",
  "artifact",
]);
export type RuntimeToolSandboxClass = z.infer<
  typeof RuntimeToolSandboxClassSchema
>;

export const RuntimeToolAvailabilitySchema = z.enum([
  "available",
  "approval_required",
  "disabled",
]);
export type RuntimeToolAvailability = z.infer<
  typeof RuntimeToolAvailabilitySchema
>;

export const RuntimePolicyModeSchema = z.enum(["allow", "ask", "deny"]);
export type RuntimePolicyMode = z.infer<typeof RuntimePolicyModeSchema>;

export const ApprovalPolicyModeSchema = z.enum(["auto", "ask", "deny"]);
export type ApprovalPolicyMode = z.infer<typeof ApprovalPolicyModeSchema>;

export const ModelToolReliabilitySchema = z.enum(["high", "medium", "low"]);

export const ToolCapabilitySchema = z
  .object({
    id: z.string().min(1),
    logicalName: z.string().min(1),
    description: z.string().min(1),
    inputSchemaVersion: z.string().min(1),
    sandboxClass: RuntimeToolSandboxClassSchema,
    availability: RuntimeToolAvailabilitySchema,
    permissionMetadata: ToolPermissionMetadataSchema,
    requiredBackendCapabilities: z.array(ToolBackendCapabilitySchema).min(1),
    riskLevel: z.enum(["low", "medium", "high", "critical"]),
    parallelism: ToolParallelismSchema,
    rendererHint: ToolRendererHintSchema,
    preferredFor: z.array(z.string().min(1)),
    avoidWhen: z.array(z.string().min(1)).optional(),
    alternatives: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type ToolCapability = z.infer<typeof ToolCapabilitySchema>;

export const UnavailableCapabilitySchema = z
  .object({
    id: z.string().min(1),
    reason: z.string().min(1),
    alternatives: z.array(z.string().min(1)),
  })
  .strict();
export type UnavailableCapability = z.infer<typeof UnavailableCapabilitySchema>;

export const FilesystemPolicySnapshotSchema = z
  .object({
    workspaceRoot: z.string().min(1),
    artifactRoot: z.string().min(1),
    writable: z.boolean(),
    pathTraversalDenied: z.boolean(),
  })
  .strict();
export type FilesystemPolicySnapshot = z.infer<
  typeof FilesystemPolicySnapshotSchema
>;

export const CommandPolicySnapshotSchema = z
  .object({
    shellAvailable: z.boolean(),
    mode: RuntimePolicyModeSchema,
    approvalRequired: z.boolean(),
    details: z.string().min(1),
  })
  .strict();
export type CommandPolicySnapshot = z.infer<typeof CommandPolicySnapshotSchema>;

export const NetworkPolicySnapshotSchema = z
  .object({
    mode: RuntimePolicyModeSchema,
    details: z.string().min(1),
  })
  .strict();
export type NetworkPolicySnapshot = z.infer<typeof NetworkPolicySnapshotSchema>;

export const GitPolicySnapshotSchema = z
  .object({
    mode: RuntimePolicyModeSchema,
    mutationRequiresApproval: z.boolean(),
    dedicatedToolsAvailable: z.boolean(),
    details: z.string().min(1),
  })
  .strict();
export type GitPolicySnapshot = z.infer<typeof GitPolicySnapshotSchema>;

export const ApprovalPolicySnapshotSchema = z
  .object({
    mode: ApprovalPolicyModeSchema,
    details: z.string().min(1),
  })
  .strict();
export type ApprovalPolicySnapshot = z.infer<
  typeof ApprovalPolicySnapshotSchema
>;

export const ModelToolProfileSchema = z
  .object({
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    schemaReliability: ModelToolReliabilitySchema,
    toolSelectionReliability: ModelToolReliabilitySchema,
    correctionReliability: ModelToolReliabilitySchema,
    maxConcurrentTools: z.number().int().positive(),
    exposeShellByDefault: z.boolean(),
    preferPurposeBuiltTools: z.boolean(),
    requiresStricterHints: z.boolean(),
  })
  .strict();
export type ModelToolProfile = z.infer<typeof ModelToolProfileSchema>;

export const CostBudgetSnapshotSchema = z
  .object({
    runBudgetUsd: z.number().nonnegative().nullable(),
    sessionBudgetUsd: z.number().nonnegative().nullable(),
  })
  .strict();
export type CostBudgetSnapshot = z.infer<typeof CostBudgetSnapshotSchema>;

export const RuntimeLimitSnapshotSchema = z
  .object({
    maxReadLines: z.number().int().positive(),
    maxSearchResults: z.number().int().positive(),
    maxWriteContentBytes: z.number().int().positive(),
  })
  .strict();
export type RuntimeLimitSnapshot = z.infer<typeof RuntimeLimitSnapshotSchema>;

export const ExecutionLocationSchema = z.enum([
  "cloud_sandbox",
  "desktop_local",
  "local_worktree",
  "cloud_vm",
  "ssh_remote",
  "self_hosted_worker",
]);
export type ExecutionLocation = z.infer<typeof ExecutionLocationSchema>;

export const RunCapabilityManifestSchema = z
  .object({
    runId: z.string().min(1),
    executionLocation: ExecutionLocationSchema,
    backendId: z.string().min(1),
    workspaceRoot: z.string().min(1),
    artifactRoot: z.string().min(1),
    availableTools: z.array(ToolCapabilitySchema),
    unavailableCapabilities: z.array(UnavailableCapabilitySchema),
    filesystemPolicy: FilesystemPolicySnapshotSchema,
    commandPolicy: CommandPolicySnapshotSchema,
    networkPolicy: NetworkPolicySnapshotSchema,
    gitPolicy: GitPolicySnapshotSchema,
    approvalPolicy: ApprovalPolicySnapshotSchema,
    modelToolProfile: ModelToolProfileSchema.nullable(),
    costBudget: CostBudgetSnapshotSchema,
    runtimeLimits: RuntimeLimitSnapshotSchema,
  })
  .strict();
export type RunCapabilityManifest = z.infer<typeof RunCapabilityManifestSchema>;

export interface RunCapabilityManifestInput {
  runId: string;
  backendId?: string;
  workspaceRoot?: string;
  artifactRoot?: string;
  availableToolIds?: readonly string[];
  providerId?: string;
  modelId?: string;
}

export function createCloudSandboxRunCapabilityManifest(
  input: RunCapabilityManifestInput,
): RunCapabilityManifest {
  const availableTools = buildToolCapabilities(input);
  const workspaceRoot =
    input.workspaceRoot ?? `/home/sandbox/runs/${input.runId}`;
  const artifactRoot = input.artifactRoot ?? `${workspaceRoot}/artifacts`;
  const manifest: RunCapabilityManifest = {
    runId: input.runId,
    executionLocation: "cloud_sandbox",
    backendId: input.backendId ?? "cloud_sandbox_free",
    workspaceRoot,
    artifactRoot,
    availableTools,
    unavailableCapabilities: buildCloudSandboxUnavailableCapabilities(),
    filesystemPolicy: buildFilesystemPolicy(workspaceRoot, artifactRoot),
    commandPolicy: buildCommandPolicy(availableTools),
    networkPolicy: buildNetworkPolicy(availableTools),
    gitPolicy: buildGitPolicy(availableTools),
    approvalPolicy: buildApprovalPolicy(availableTools),
    modelToolProfile: createModelToolProfileIfConfigured(input),
    costBudget: { runBudgetUsd: null, sessionBudgetUsd: null },
    runtimeLimits: buildRuntimeLimits(),
  };
  return RunCapabilityManifestSchema.parse(manifest);
}

export function createDefaultModelToolProfile(
  input: Required<Pick<RunCapabilityManifestInput, "providerId" | "modelId">>,
): ModelToolProfile {
  return {
    providerId: input.providerId,
    modelId: input.modelId,
    schemaReliability: "medium",
    toolSelectionReliability: "medium",
    correctionReliability: "medium",
    maxConcurrentTools: 1,
    exposeShellByDefault: true,
    preferPurposeBuiltTools: true,
    requiresStricterHints: false,
  };
}

function createModelToolProfileIfConfigured(
  input: RunCapabilityManifestInput,
): ModelToolProfile | null {
  if (!input.providerId || !input.modelId) {
    return null;
  }
  return createDefaultModelToolProfile({
    providerId: input.providerId,
    modelId: input.modelId,
  });
}

function buildToolCapabilities(
  input: RunCapabilityManifestInput,
): ToolCapability[] {
  const definitions = getCodingToolDefinitions();
  const allowedIds = input.availableToolIds
    ? new Set(input.availableToolIds)
    : null;
  return definitions
    .filter((definition) => !allowedIds || allowedIds.has(definition.id))
    .map(buildToolCapability);
}

function buildToolCapability(definition: ToolDefinition): ToolCapability {
  return {
    id: definition.id,
    logicalName: definition.id,
    description: definition.description,
    inputSchemaVersion: "zod:v1",
    sandboxClass: normalizeSandboxClass(definition.sandboxClass),
    availability: mapPermissionAvailability(definition.permission),
    permissionMetadata: definition.permissionMetadata,
    requiredBackendCapabilities: [...definition.requiredBackendCapabilities],
    riskLevel: definition.riskLevel,
    parallelism: definition.parallelism,
    rendererHint: definition.rendererHint,
    preferredFor: [...definition.preferredFor],
    avoidWhen: definition.avoidWhen ? [...definition.avoidWhen] : undefined,
    alternatives: definition.alternatives
      ? [...definition.alternatives]
      : undefined,
  };
}

function mapPermissionAvailability(
  permission: ToolPermissionPolicy,
): RuntimeToolAvailability {
  if (permission.mode === "approval_required") {
    return "approval_required";
  }
  return permission.mode === "deny" ? "disabled" : "available";
}

function normalizeSandboxClass(
  sandboxClass: ToolSandboxClass,
): RuntimeToolSandboxClass {
  return sandboxClass;
}

function buildFilesystemPolicy(
  workspaceRoot: string,
  artifactRoot: string,
): FilesystemPolicySnapshot {
  return {
    workspaceRoot,
    artifactRoot,
    writable: true,
    pathTraversalDenied: true,
  };
}

function buildCommandPolicy(
  tools: readonly ToolCapability[],
): CommandPolicySnapshot {
  const shellTool = tools.find((tool) => tool.sandboxClass === "shell");
  return {
    shellAvailable: Boolean(shellTool),
    mode: shellTool ? "ask" : "deny",
    approvalRequired: shellTool?.availability === "approval_required",
    details: shellTool
      ? "Shell is available but approval-gated for workspace commands."
      : "Shell is unavailable in this runtime.",
  };
}

function buildNetworkPolicy(
  tools: readonly ToolCapability[],
): NetworkPolicySnapshot {
  const hasNetworkTools = tools.some((tool) => tool.sandboxClass === "network");
  return {
    mode: hasNetworkTools ? "allow" : "deny",
    details: hasNetworkTools
      ? "Network access is limited to exposed runtime tools."
      : "Network access is not exposed to this run.",
  };
}

function buildGitPolicy(tools: readonly ToolCapability[]): GitPolicySnapshot {
  const gitTools = tools.filter((tool) => tool.sandboxClass === "git");
  return {
    mode: gitTools.length > 0 ? "ask" : "deny",
    mutationRequiresApproval: gitTools.some(
      (tool) => tool.availability === "approval_required",
    ),
    dedicatedToolsAvailable: gitTools.length > 0,
    details:
      "Use dedicated git tools for repository status, diff, and mutations.",
  };
}

function buildApprovalPolicy(
  tools: readonly ToolCapability[],
): ApprovalPolicySnapshot {
  const hasApprovalTools = tools.some(
    (tool) => tool.availability === "approval_required",
  );
  return {
    mode: hasApprovalTools ? "ask" : "auto",
    details: hasApprovalTools
      ? "Mutating tools require user approval before execution."
      : "Available tools can run without explicit approval.",
  };
}

function buildRuntimeLimits(): RuntimeLimitSnapshot {
  return {
    maxReadLines: MAX_TOOL_READ_LINES,
    maxSearchResults: MAX_TOOL_SEARCH_RESULTS,
    maxWriteContentBytes: MAX_TOOL_WRITE_CONTENT_LENGTH,
  };
}

function buildCloudSandboxUnavailableCapabilities(): UnavailableCapability[] {
  return [
    {
      id: "desktop_local",
      reason:
        "Cloud sandbox runs cannot access the user's local machine or desktop apps.",
      alternatives: ["read_file", "list_files", "glob", "grep", "bash"],
    },
    {
      id: "browser_automation",
      reason:
        "Browser automation is unavailable unless a browser tool is explicitly exposed.",
      alternatives: ["read_file", "grep", "github_pr_get"],
    },
    {
      id: "outside_workspace_files",
      reason: "Filesystem tools are scoped to the checked-out run workspace.",
      alternatives: ["read_file", "list_files", "glob", "grep"],
    },
  ];
}
