import { describe, expect, it } from "vitest";
import {
  buildCorrectionHintText,
  buildRuntimeCapabilityPromptSection,
  buildToolCatalogSnapshot,
  buildUnavailableToolError,
  createCloudSandboxRunCapabilityManifest,
  RunCapabilityManifestSchema,
} from "./index.js";

describe("runtime capability manifest", () => {
  it("builds a cloud sandbox manifest from available coding tools", () => {
    const manifest = createCloudSandboxRunCapabilityManifest({
      runId: "run-1",
      availableToolIds: ["read_file", "grep", "bash", "git_status"],
      providerId: "openai",
      modelId: "gpt-5.1-codex",
    });

    expect(RunCapabilityManifestSchema.parse(manifest)).toEqual(manifest);
    expect(manifest.executionLocation).toBe("cloud_sandbox");
    expect(manifest.modelToolProfile).toMatchObject({
      providerId: "openai",
      modelId: "gpt-5.1-codex",
      preferPurposeBuiltTools: true,
    });
    expect(manifest.availableTools.map((tool) => tool.logicalName)).toEqual([
      "read_file",
      "bash",
      "git_status",
      "grep",
    ]);
    expect(
      manifest.availableTools.find((tool) => tool.logicalName === "bash"),
    ).toMatchObject({
      permissionMetadata: {
        domain: "command",
        subject: "bash",
        riskLevel: "high",
      },
      requiredBackendCapabilities: ["shell", "approval"],
      parallelism: "exclusive_workspace_write",
      rendererHint: "shell",
    });
    expect(manifest.commandPolicy).toMatchObject({
      shellAvailable: true,
      mode: "ask",
      approvalRequired: true,
    });
  });

  it("generates a prompt-facing catalog snapshot", () => {
    const manifest = createCloudSandboxRunCapabilityManifest({
      runId: "run-1",
      availableToolIds: ["read_file", "glob"],
    });
    const snapshot = buildToolCatalogSnapshot(manifest);

    expect(snapshot.backendId).toBe("cloud_sandbox_free");
    expect(snapshot.tools).toEqual([
      expect.objectContaining({
        name: "read_file",
        availability: "available",
        preferredFor: [
          "file inspection",
          "line-numbered range reads",
          "continuing with nextOffset after truncation",
        ],
      }),
      expect.objectContaining({
        name: "glob",
        sandboxClass: "read",
      }),
    ]);
    expect(snapshot.unavailableCapabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "desktop_local" }),
      ]),
    );
  });

  it("renders execution environment guidance from the manifest", () => {
    const manifest = createCloudSandboxRunCapabilityManifest({
      runId: "run-1",
      availableToolIds: ["read_file", "bash"],
    });
    const prompt = buildRuntimeCapabilityPromptSection(manifest);

    expect(prompt).toContain("## Execution Environment");
    expect(prompt).toContain("executionLocation: cloud_sandbox");
    expect(prompt).toContain("- read_file [read, available]");
    expect(prompt).toContain("- bash [shell, approval_required]");
    expect(prompt).toContain("desktop_local");
    expect(prompt).toContain("do not use shell commands like sed");
  });

  it("builds structured unavailable tool errors with correction hints", () => {
    const manifest = createCloudSandboxRunCapabilityManifest({
      runId: "run-1",
      availableToolIds: ["read_file", "grep", "bash"],
    });
    const error = buildUnavailableToolError({
      attemptedTool: "open_desktop_app",
      manifest,
    });
    const hint = buildCorrectionHintText(error);

    expect(error).toMatchObject({
      code: "TOOL_UNAVAILABLE_IN_BACKEND",
      attemptedTool: "open_desktop_app",
      executionLocation: "cloud_sandbox",
      availableAlternatives: ["read_file", "grep", "bash"],
    });
    expect(hint).toContain("Reminder: this run is in cloud_sandbox.");
    expect(hint).toContain("Available tools: read_file, bash, grep.");
  });
});
