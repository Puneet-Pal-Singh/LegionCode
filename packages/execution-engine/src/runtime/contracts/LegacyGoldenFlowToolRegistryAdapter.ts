import type { CoreTool } from "ai";
import {
  enforceCodingToolFloor,
  getCodingCoreToolRegistry,
  getCodingToolIds,
  getCodingToolRoute,
  isCodingToolId,
  isMutatingCodingToolId,
  validateCodingToolInput,
  type CodingToolId,
  type CodingToolInputByName,
  type ToolGatewayRoute,
} from "../tools/CodingToolRegistry.js";
import {
  buildToolCatalogSnapshot,
  createCloudSandboxRunCapabilityManifest,
  RunCapabilityManifest,
  RunCapabilityManifestInput,
  ToolCatalogSnapshot,
} from "../capabilities/index.js";

export {
  getCodingToolDefinition,
  getCodingToolDefinitions,
  isCodingToolId,
  type ToolDefinition,
  type ToolResult,
} from "../tools/CodingToolRegistry.js";

/**
 * @deprecated Quarantined legacy adapter for pre-cutover GoldenFlow package
 * consumers only. Runtime, Brain, and tool execution paths must import
 * CodingToolRegistry directly; runtime-conformance gates enforce that boundary.
 *
 * Owner: Runtime platform.
 * Why it exists: package-level consumers still import the old GoldenFlow names.
 * Canonical path: packages/execution-engine/src/runtime/tools/CodingToolRegistry.ts.
 * Deletion criteria: remove this adapter when no exported package consumer imports
 * GoldenFlow-prefixed names and the public SDK compatibility window closes.
 */
export type GoldenFlowToolName = CodingToolId;
export type GoldenFlowToolInputByName = CodingToolInputByName;
export type { ToolGatewayRoute };

export function getGoldenFlowToolNames(): GoldenFlowToolName[] {
  return getCodingToolIds();
}

export function isGoldenFlowToolName(
  value: string,
): value is GoldenFlowToolName {
  return isCodingToolId(value);
}

export function isMutatingGoldenFlowToolName(toolName: string): boolean {
  return isMutatingCodingToolId(toolName);
}

export function getGoldenFlowToolRoute(
  toolName: string,
): ToolGatewayRoute | null {
  return getCodingToolRoute(toolName);
}

export function getGoldenFlowToolRegistry(): Record<string, CoreTool> {
  return getCodingCoreToolRegistry();
}

export function getGoldenFlowRunCapabilityManifest(
  input: RunCapabilityManifestInput & { availableToolIds: readonly string[] },
): RunCapabilityManifest {
  return createCloudSandboxRunCapabilityManifest(input);
}

export function getGoldenFlowToolCatalogSnapshot(
  input: RunCapabilityManifestInput & { availableToolIds: readonly string[] },
): ToolCatalogSnapshot {
  return buildToolCatalogSnapshot(getGoldenFlowRunCapabilityManifest(input));
}

export function enforceGoldenFlowToolFloor(
  incomingTools: Record<string, CoreTool>,
  metadata?: Record<string, unknown>,
): Record<string, CoreTool> {
  return enforceCodingToolFloor(incomingTools, metadata);
}

export function validateGoldenFlowToolInput<T extends GoldenFlowToolName>(
  toolName: T,
  input: unknown,
): GoldenFlowToolInputByName[T] {
  return validateCodingToolInput(toolName, input);
}
