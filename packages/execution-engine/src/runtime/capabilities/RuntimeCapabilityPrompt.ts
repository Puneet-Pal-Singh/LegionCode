import { buildToolCatalogSnapshot } from "./ToolCatalogSnapshot.js";
import type { ToolCatalogEntry } from "./ToolCatalogSnapshot.js";
import type {
  RunCapabilityManifest,
  UnavailableCapability,
} from "./RuntimeCapabilityManifest.js";

export function buildRuntimeCapabilityPromptSection(
  manifest: RunCapabilityManifest,
): string {
  const catalog = buildToolCatalogSnapshot(manifest);
  return [
    "## Execution Environment",
    ...buildEnvironmentLines(manifest),
    "",
    "## Runtime Tool Catalog",
    ...catalog.tools.map(formatToolLine),
    "",
    "Unavailable capabilities:",
    ...manifest.unavailableCapabilities.map(formatUnavailableCapability),
    "",
    "## Shell Command Guidance",
    ...buildShellGuidanceLines(manifest),
  ].join("\n");
}

function buildEnvironmentLines(manifest: RunCapabilityManifest): string[] {
  return [
    "You are running inside LegionCode Cloud Sandbox.",
    `Current backend: ${manifest.backendId}`,
    `executionLocation: ${manifest.executionLocation}`,
    `workspaceRoot: ${manifest.workspaceRoot}`,
    `artifactRoot: ${manifest.artifactRoot}`,
    `shellAvailable: ${manifest.commandPolicy.shellAvailable}`,
    `networkPolicy: ${manifest.networkPolicy.mode} - ${manifest.networkPolicy.details}`,
    `gitPolicy: ${manifest.gitPolicy.mode} - ${manifest.gitPolicy.details}`,
    `approvalPolicy: ${manifest.approvalPolicy.mode} - ${manifest.approvalPolicy.details}`,
    "You can access the checked-out repository files and generated artifacts for this run.",
    "You cannot access the user's local machine, desktop apps, or browser tabs unless a matching tool is explicitly available.",
  ];
}

function buildShellGuidanceLines(manifest: RunCapabilityManifest): string[] {
  if (!manifest.commandPolicy.shellAvailable) {
    return ["Shell commands are unavailable in this runtime."];
  }
  return [
    "Shell commands may require user approval.",
    "For simple file inspection, do not use shell commands like sed, cat, or grep when read_file, list_files, glob, or grep tools are available.",
    "Use shell for package scripts, tests, builds, and commands that have no purpose-built LegionCode tool.",
  ];
}

function formatToolLine(tool: ToolCatalogEntry): string {
  const preferred = tool.preferredFor.join(", ");
  const avoid = tool.avoidWhen?.length
    ? ` Avoid when: ${tool.avoidWhen.join(", ")}.`
    : "";
  return `- ${tool.name} [${tool.sandboxClass}, ${tool.availability}]: ${tool.description} Preferred for: ${preferred}.${avoid}`;
}

function formatUnavailableCapability(
  capability: UnavailableCapability,
): string {
  return `- ${capability.id}: ${capability.reason} Alternatives: ${capability.alternatives.join(", ")}.`;
}
