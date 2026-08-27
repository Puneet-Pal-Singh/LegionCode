/**
 * AgentTypePolicy - Validate and resolve agent types.
 *
 * Single Responsibility: Enforce agent type validation policy.
 * In strict mode (default): reject unsupported agent types with error.
 * In compat mode: silently fallback to "coding" agent (backward compatibility).
 */

import { PolicyError } from "../../domain/errors";
import {
  AgentRegistry,
  type AgentType,
} from "@legioncode/execution-engine/runtime";

interface AgentTypePolicyOptions {
  /**
   * If true (default): throw PolicyError for unsupported agent types.
   * If false: silently fallback to "coding" agent.
   */
  strict?: boolean;
  correlationId?: string;
}

/**
 * Resolve and validate requested agent type against registry.
 *
 * Strict Mode (default):
 * - If agent type is registered: return it
 * - If agent type is not registered: throw PolicyError
 * - Rationale: Explicit failure helps catch bugs in client code
 *
 * Compat Mode (strict: false):
 * - If agent type is registered: return it
 * - If agent type is not registered: log warning, fallback to "coding"
 * - Rationale: Backward compatibility during migration
 *
 * @param requestedType - Agent type from request
 * @param registry - Registry of available agents
 * @param options - Policy options
 * @returns Resolved agent type
 * @throws PolicyError if strict mode and agent not registered
 */
export function resolveAgentType(
  requestedType: AgentType,
  registry: AgentRegistry,
  options: AgentTypePolicyOptions = {},
): AgentType {
  const { strict = true, correlationId } = options;

  if (registry.has(requestedType)) {
    return requestedType;
  }

  const fallbackType: AgentType = "coding";

  if (strict) {
    throw new PolicyError(
      `Agent type "${requestedType}" is not supported. Use "coding", "review", or "ci".`,
      "UNSUPPORTED_AGENT_TYPE",
      correlationId,
    );
  }

  // Compat mode: log warning and fallback
  const idPart = correlationId ? `${correlationId}: ` : "";
  console.warn(
    `[runtime/agent-policy] ${idPart}Unsupported agent type "${requestedType}". Falling back to "${fallbackType}".`,
  );
  return fallbackType;
}
