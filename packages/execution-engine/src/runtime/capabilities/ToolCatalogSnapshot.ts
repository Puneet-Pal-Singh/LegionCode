import { z } from "zod";
import type {
  RunCapabilityManifest,
  ToolCapability,
  UnavailableCapability,
} from "./RuntimeCapabilityManifest.js";

export const ToolCatalogEntrySchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    sandboxClass: z.string().min(1),
    availability: z.enum(["available", "approval_required", "disabled"]),
    preferredFor: z.array(z.string().min(1)),
    avoidWhen: z.array(z.string().min(1)).optional(),
    alternatives: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type ToolCatalogEntry = z.infer<typeof ToolCatalogEntrySchema>;

export const ToolCatalogSnapshotSchema = z
  .object({
    backendId: z.string().min(1),
    executionLocation: z.string().min(1),
    generatedAt: z.string().min(1),
    tools: z.array(ToolCatalogEntrySchema),
    unavailableCapabilities: z.array(
      z
        .object({
          id: z.string().min(1),
          reason: z.string().min(1),
          alternatives: z.array(z.string().min(1)),
        })
        .strict(),
    ),
  })
  .strict();
export type ToolCatalogSnapshot = z.infer<typeof ToolCatalogSnapshotSchema>;

export function buildToolCatalogSnapshot(
  manifest: RunCapabilityManifest,
): ToolCatalogSnapshot {
  return ToolCatalogSnapshotSchema.parse({
    backendId: manifest.backendId,
    executionLocation: manifest.executionLocation,
    generatedAt: new Date().toISOString(),
    tools: manifest.availableTools.map(buildCatalogEntry),
    unavailableCapabilities: manifest.unavailableCapabilities.map(
      copyUnavailableCapability,
    ),
  });
}

export function getAvailableToolNames(
  snapshot: Pick<ToolCatalogSnapshot, "tools">,
): string[] {
  return snapshot.tools
    .filter((tool) => tool.availability !== "disabled")
    .map((tool) => tool.name);
}

function buildCatalogEntry(tool: ToolCapability): ToolCatalogEntry {
  return {
    name: tool.logicalName,
    description: tool.description,
    sandboxClass: tool.sandboxClass,
    availability: tool.availability,
    preferredFor: [...tool.preferredFor],
    avoidWhen: tool.avoidWhen ? [...tool.avoidWhen] : undefined,
    alternatives: tool.alternatives ? [...tool.alternatives] : undefined,
  };
}

function copyUnavailableCapability(
  capability: UnavailableCapability,
): UnavailableCapability {
  return {
    id: capability.id,
    reason: capability.reason,
    alternatives: [...capability.alternatives],
  };
}
