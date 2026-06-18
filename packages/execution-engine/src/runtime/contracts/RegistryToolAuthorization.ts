import {
  evaluatePermission,
  type PermissionPolicy,
  type PermissionRequest,
  type PolicyDecisionResult,
} from "@repo/permission-policy";
import {
  ApprovalIdSchema,
  ItemIdSchema,
  JsonRecordSchema,
  type PermissionProfileId,
  type RunMode,
} from "@repo/platform-protocol";
import type {
  ToolAuthorizationPort,
  ToolAuthorizationResult,
} from "@repo/runtime-kernel";
import {
  codingToolRegistry,
  type ToolDefinition,
} from "../tools/CodingToolRegistry.js";

const READ_ONLY_RUN_MODES = new Set<RunMode>(["ask", "review", "plan"]);

export interface PermissionPolicyResolver {
  resolve(permissionProfileId: PermissionProfileId): Promise<PermissionPolicy>;
}

export class RegistryToolAuthorization implements ToolAuthorizationPort {
  constructor(private readonly policies: PermissionPolicyResolver) {}

  async authorize(
    input: Parameters<ToolAuthorizationPort["authorize"]>[0],
  ): Promise<ToolAuthorizationResult> {
    const resolved = resolveRegisteredToolCall(input.toolCall);
    if (resolved.status === "rejected") {
      return resolved;
    }
    if (isReadOnlyMutation(input.run.mode, resolved.definition)) {
      return reject(
        "tool_policy_denied",
        `Run mode "${input.run.mode}" does not permit mutating tool "${resolved.definition.id}".`,
      );
    }

    const policy = await this.policies.resolve(input.run.permissionProfileId);
    const decision = evaluatePermission(
      policy,
      buildPermissionRequest(resolved.definition, resolved.toolCall.input),
    );
    return mapPolicyDecision(decision, resolved, input);
  }
}

type AuthorizationInput = Parameters<ToolAuthorizationPort["authorize"]>[0];
type RegisteredToolCall = {
  status: "registered";
  definition: ToolDefinition;
  toolCall: AuthorizationInput["toolCall"];
};

function resolveRegisteredToolCall(
  toolCall: AuthorizationInput["toolCall"],
):
  | RegisteredToolCall
  | Extract<ToolAuthorizationResult, { status: "rejected" }> {
  const definition = codingToolRegistry.getDefinition(toolCall.toolName);
  if (definition === null) {
    return reject(
      "tool_not_registered",
      `Tool "${toolCall.toolName}" is not registered.`,
    );
  }
  const parsedInput = definition.inputSchema.safeParse(toolCall.input);
  if (!parsedInput.success) {
    return reject(
      "invalid_tool_input",
      `Input for tool "${definition.id}" does not match its registered schema.`,
    );
  }
  return {
    status: "registered",
    definition,
    toolCall: { ...toolCall, input: JsonRecordSchema.parse(parsedInput.data) },
  };
}

function mapPolicyDecision(
  decision: PolicyDecisionResult,
  resolved: RegisteredToolCall,
  input: AuthorizationInput,
): ToolAuthorizationResult {
  if (decision.effect === "deny") {
    return reject("tool_policy_denied", decision.reason);
  }
  if (decision.effect === "allow") {
    return { status: "authorized", toolCall: resolved.toolCall };
  }
  const { definition, toolCall } = resolved;
  return {
    status: "approval_required",
    toolCall,
    request: {
      approvalId: createApprovalId(toolCall.toolCallId),
      itemId: createApprovalItemId(toolCall.toolCallId),
      question: decision.approval.prompt,
      options: [
        {
          id: "approve",
          label: "Approve",
          description: "Allow this exact tool call",
        },
        { id: "deny", label: "Deny", description: null },
      ],
      metadata: {
        toolName: definition.id,
        action: definition.permissionMetadata.action ?? definition.id,
        riskLevel: decision.riskLevel,
        permissionProfileId: input.run.permissionProfileId,
      },
    },
  };
}

function isReadOnlyMutation(
  mode: RunMode,
  definition: ToolDefinition,
): boolean {
  return (
    READ_ONLY_RUN_MODES.has(mode) && definition.parallelism !== "parallel_safe"
  );
}

function buildPermissionRequest(
  definition: ToolDefinition,
  input: Record<string, unknown>,
): PermissionRequest {
  const { domain, subject, action } = definition.permissionMetadata;
  switch (domain) {
    case "command":
      return { domain, command: readString(input.command) ?? subject };
    case "path":
      return {
        domain,
        path: readString(input.path) ?? subject,
        operation: definition.sandboxClass === "read" ? "read" : "write",
      };
    case "network":
      return {
        domain,
        url: buildNetworkUrl(input, subject),
        operation: "fetch",
      };
    case "git":
      return { domain, operation: action ?? subject };
    case "package_manager":
      return { domain, manager: subject, operation: action ?? subject };
    case "secret":
      return { domain, secretRef: subject, operation: "use" };
    case "external_service":
      return { domain, service: subject, operation: action ?? subject };
    case "tool":
      return { domain, toolName: subject, action };
  }
}

function buildNetworkUrl(
  input: Record<string, unknown>,
  fallbackPath: string,
): string {
  const directUrl = readString(input.url);
  if (directUrl) {
    return directUrl;
  }
  const owner = readString(input.owner);
  const repo = readString(input.repo);
  return owner && repo
    ? `https://github.com/${owner}/${repo}`
    : `https://github.com/${fallbackPath}`;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function createApprovalId(toolCallId: string) {
  return ApprovalIdSchema.parse(toolCallId.replace(/^toolcall_/, "appr_"));
}

function createApprovalItemId(toolCallId: string) {
  return ItemIdSchema.parse(toolCallId.replace(/^toolcall_/, "itm_approval_"));
}

function reject(
  code: Extract<ToolAuthorizationResult, { status: "rejected" }>["code"],
  reason: string,
): Extract<ToolAuthorizationResult, { status: "rejected" }> {
  return { status: "rejected", code, reason };
}
