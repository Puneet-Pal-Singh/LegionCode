import { z } from "zod";
import {
  getAvailableToolNames,
  type ToolCatalogSnapshot,
} from "./ToolCatalogSnapshot.js";
import type { RunCapabilityManifest } from "./RuntimeCapabilityManifest.js";

export const StructuredToolErrorCodeSchema = z.enum([
  "TOOL_UNAVAILABLE_IN_BACKEND",
  "INVALID_TOOL_INPUT",
  "PREFER_PURPOSE_BUILT_TOOL",
]);
export type StructuredToolErrorCode = z.infer<
  typeof StructuredToolErrorCodeSchema
>;

export const ToolCorrectionHintSchema = z
  .object({
    message: z.string().min(1),
    availableTools: z.array(z.string().min(1)),
    preferredTools: z.array(z.string().min(1)),
  })
  .strict();
export type ToolCorrectionHint = z.infer<typeof ToolCorrectionHintSchema>;

export const StructuredToolErrorSchema = z
  .object({
    code: StructuredToolErrorCodeSchema,
    attemptedTool: z.string().min(1),
    message: z.string().min(1),
    executionLocation: z.string().min(1),
    availableAlternatives: z.array(z.string().min(1)),
    correctionHint: ToolCorrectionHintSchema,
    details: z.record(z.unknown()).optional(),
  })
  .strict();
export type StructuredToolError = z.infer<typeof StructuredToolErrorSchema>;

export function buildUnavailableToolError(input: {
  attemptedTool: string;
  manifest: RunCapabilityManifest;
}): StructuredToolError {
  return StructuredToolErrorSchema.parse({
    code: "TOOL_UNAVAILABLE_IN_BACKEND",
    attemptedTool: input.attemptedTool,
    message: `Tool "${input.attemptedTool}" is unavailable in this backend.`,
    executionLocation: input.manifest.executionLocation,
    availableAlternatives: selectAlternativeTools(input.manifest),
    correctionHint: buildCorrectionHint(input.manifest, [
      "read_file",
      "list_files",
      "glob",
      "grep",
    ]),
  });
}

export function buildInvalidToolInputError(input: {
  attemptedTool: string;
  validationMessage: string;
  manifest: RunCapabilityManifest;
}): StructuredToolError {
  return StructuredToolErrorSchema.parse({
    code: "INVALID_TOOL_INPUT",
    attemptedTool: input.attemptedTool,
    message: input.validationMessage,
    executionLocation: input.manifest.executionLocation,
    availableAlternatives: selectAlternativeTools(input.manifest),
    correctionHint: buildCorrectionHint(input.manifest, [input.attemptedTool]),
    details: { validationMessage: input.validationMessage },
  });
}

export function buildPurposeBuiltToolWarning(input: {
  attemptedTool: string;
  command?: string;
  manifest: RunCapabilityManifest;
}): StructuredToolError {
  return StructuredToolErrorSchema.parse({
    code: "PREFER_PURPOSE_BUILT_TOOL",
    attemptedTool: input.attemptedTool,
    message: "Prefer a purpose-built repository tool before shell.",
    executionLocation: input.manifest.executionLocation,
    availableAlternatives: selectAlternativeTools(input.manifest),
    correctionHint: buildCorrectionHint(input.manifest, [
      "read_file",
      "list_files",
      "glob",
      "grep",
    ]),
    details: input.command ? { command: input.command } : undefined,
  });
}

export function buildCorrectionHintText(
  error: Pick<
    StructuredToolError,
    "code" | "executionLocation" | "correctionHint"
  >,
): string {
  const available = error.correctionHint.availableTools.join(", ");
  const preferred = error.correctionHint.preferredTools.join(", ");
  return [
    `Reminder: this run is in ${error.executionLocation}.`,
    error.correctionHint.message,
    `Preferred tools: ${preferred}.`,
    `Available tools: ${available}.`,
  ].join(" ");
}

export function serializeStructuredToolError(
  error: StructuredToolError,
): string {
  return JSON.stringify(
    {
      error: error.code,
      attemptedTool: error.attemptedTool,
      executionLocation: error.executionLocation,
      availableAlternatives: error.availableAlternatives,
      instruction: error.correctionHint.message,
      details: error.details,
    },
    null,
    2,
  );
}

export function buildToolCorrectionHint(
  snapshot: ToolCatalogSnapshot,
): ToolCorrectionHint {
  const availableTools = getAvailableToolNames(snapshot);
  return ToolCorrectionHintSchema.parse({
    message:
      "Use only tools exposed in this run. For file inspection, use read_file, list_files, glob, or grep before shell.",
    availableTools,
    preferredTools: filterPresentTools(availableTools, [
      "read_file",
      "list_files",
      "glob",
      "grep",
    ]),
  });
}

function buildCorrectionHint(
  manifest: RunCapabilityManifest,
  preferredTools: readonly string[],
): ToolCorrectionHint {
  const availableTools = manifest.availableTools
    .filter((tool) => tool.availability !== "disabled")
    .map((tool) => tool.logicalName);
  return ToolCorrectionHintSchema.parse({
    message:
      "Use available repository and runtime tools only; do not invent desktop or local-machine tools.",
    availableTools,
    preferredTools: filterPresentTools(availableTools, preferredTools),
  });
}

function selectAlternativeTools(manifest: RunCapabilityManifest): string[] {
  const preferred = ["read_file", "list_files", "glob", "grep", "bash"];
  const available = manifest.availableTools
    .filter((tool) => tool.availability !== "disabled")
    .map((tool) => tool.logicalName);
  return filterPresentTools(available, preferred);
}

function filterPresentTools(
  availableTools: readonly string[],
  preferredTools: readonly string[],
): string[] {
  const available = new Set(availableTools);
  return preferredTools.filter((tool) => available.has(tool));
}
