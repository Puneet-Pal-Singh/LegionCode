import { describe, expect, it } from "vitest";
import {
  enforceGoldenFlowToolFloor,
  getCodingToolDefinition,
  getGoldenFlowRunCapabilityManifest,
  getGoldenFlowToolCatalogSnapshot,
  getGoldenFlowToolNames,
  getGoldenFlowToolRegistry,
  getGoldenFlowToolRoute,
  isMutatingGoldenFlowToolName,
  validateGoldenFlowToolInput,
} from "./CodingToolGateway.js";
import { ToolDefinitionSchema } from "../tools/CodingToolRegistry.js";

describe("CodingToolGateway", () => {
  it("exposes the canonical golden-flow tool floor", () => {
    const names = getGoldenFlowToolNames();
    expect(names).toEqual([
      "read_file",
      "list_files",
      "write_file",
      "bash",
      "git_stage",
      "git_commit",
      "git_push",
      "git_pull",
      "git_create_pull_request",
      "git_branch_create",
      "git_branch_switch",
      "git_status",
      "git_diff",
      "github_pr_list",
      "github_pr_get",
      "github_pr_checks_get",
      "github_review_threads_get",
      "github_issue_get",
      "github_actions_run_get",
      "github_actions_job_logs_get",
      "github_cli_pr_checks_get",
      "github_cli_actions_run_get",
      "github_cli_actions_job_logs_get",
      "github_cli_pr_comment",
      "glob",
      "grep",
    ]);

    const registry = getGoldenFlowToolRegistry();
    expect(Object.keys(registry)).toEqual(names);
  });

  it("maps llm-facing tool names to deterministic gateway routes", () => {
    expect(getGoldenFlowToolRoute("read_file")).toEqual({
      toolName: "read_file",
      plugin: "filesystem",
      action: "read_file",
    });
    expect(getGoldenFlowToolRoute("bash")).toEqual({
      toolName: "bash",
      plugin: "bash",
      action: "run",
    });
    expect(getGoldenFlowToolRoute("git_diff")).toEqual({
      toolName: "git_diff",
      plugin: "git",
      action: "git_diff",
    });
    expect(getGoldenFlowToolRoute("git_commit")).toEqual({
      toolName: "git_commit",
      plugin: "git",
      action: "git_commit",
    });
    expect(getGoldenFlowToolRoute("github_pr_get")).toEqual({
      toolName: "github_pr_get",
      plugin: "github",
      action: "pr_get",
    });
    expect(getGoldenFlowToolRoute("github_pr_list")).toEqual({
      toolName: "github_pr_list",
      plugin: "github",
      action: "pr_list",
    });
    expect(getGoldenFlowToolRoute("github_actions_run_get")).toEqual({
      toolName: "github_actions_run_get",
      plugin: "github",
      action: "actions_run_get",
    });
    expect(getGoldenFlowToolRoute("github_actions_job_logs_get")).toEqual({
      toolName: "github_actions_job_logs_get",
      plugin: "github",
      action: "actions_job_logs_get",
    });
    expect(getGoldenFlowToolRoute("github_cli_pr_checks_get")).toEqual({
      toolName: "github_cli_pr_checks_get",
      plugin: "github_cli",
      action: "pr_checks_get",
    });
    expect(getGoldenFlowToolRoute("github_cli_actions_run_get")).toEqual({
      toolName: "github_cli_actions_run_get",
      plugin: "github_cli",
      action: "actions_run_get",
    });
    expect(getGoldenFlowToolRoute("github_cli_actions_job_logs_get")).toEqual({
      toolName: "github_cli_actions_job_logs_get",
      plugin: "github_cli",
      action: "actions_job_logs_get",
    });
    expect(getGoldenFlowToolRoute("github_cli_pr_comment")).toEqual({
      toolName: "github_cli_pr_comment",
      plugin: "github_cli",
      action: "pr_comment",
    });
    expect(getGoldenFlowToolRoute("git_pull")).toEqual({
      toolName: "git_pull",
      plugin: "git",
      action: "git_pull",
    });
    expect(getGoldenFlowToolRoute("git_create_pull_request")).toEqual({
      toolName: "git_create_pull_request",
      plugin: "git",
      action: "git_create_pull_request",
    });
    expect(getGoldenFlowToolRoute("glob")).toEqual({
      toolName: "glob",
      plugin: "filesystem",
      action: "glob",
    });
    expect(getGoldenFlowToolRoute("grep")).toEqual({
      toolName: "grep",
      plugin: "filesystem",
      action: "grep",
    });
    expect(getGoldenFlowToolRoute("unknown_tool")).toBeNull();
  });

  it("classifies mutating golden-flow tools conservatively", () => {
    expect(isMutatingGoldenFlowToolName("write_file")).toBe(true);
    expect(isMutatingGoldenFlowToolName("bash")).toBe(true);
    expect(isMutatingGoldenFlowToolName("git_commit")).toBe(true);
    expect(isMutatingGoldenFlowToolName("git_pull")).toBe(true);
    expect(isMutatingGoldenFlowToolName("git_create_pull_request")).toBe(true);
    expect(isMutatingGoldenFlowToolName("github_cli_pr_comment")).toBe(true);
    expect(isMutatingGoldenFlowToolName("github_pr_get")).toBe(false);
    expect(isMutatingGoldenFlowToolName("read_file")).toBe(false);
    expect(isMutatingGoldenFlowToolName("glob")).toBe(false);
    expect(isMutatingGoldenFlowToolName("grep")).toBe(false);
    expect(isMutatingGoldenFlowToolName("git_diff")).toBe(false);
  });

  it("exposes data-driven registry metadata for read search tools", () => {
    const readDefinition = getCodingToolDefinition("read_file");
    const grepDefinition = getCodingToolDefinition("grep");

    expect(readDefinition).toMatchObject({
      id: "read_file",
      permission: { mode: "allow", scope: "workspace" },
      sandboxClass: "read",
      outputRenderer: "text",
    });
    expect(grepDefinition).toMatchObject({
      id: "grep",
      description: expect.stringContaining("regular expression"),
      permission: { mode: "allow", scope: "workspace" },
      sandboxClass: "read",
      outputRenderer: "json",
      route: { plugin: "filesystem", action: "grep" },
    });
    expect(grepDefinition?.tokenPolicy).toMatchObject({
      maxOutputBytes: expect.any(Number),
      maxLineBytes: expect.any(Number),
      maxResults: expect.any(Number),
    });
    expect(ToolDefinitionSchema.parse(grepDefinition)).toMatchObject({
      id: "grep",
      permissionMetadata: {
        domain: "tool",
        subject: "grep",
        action: "grep",
        riskLevel: "low",
      },
      requiredBackendCapabilities: ["filesystem_read"],
      riskLevel: "low",
      parallelism: "parallel_safe",
      rendererHint: "json",
    });
  });

  it("validates every native tool registry definition", () => {
    for (const toolName of getGoldenFlowToolNames()) {
      const definition = getCodingToolDefinition(toolName);
      expect(definition).toBeDefined();
      expect(ToolDefinitionSchema.safeParse(definition).success).toBe(true);
      expect(definition?.permissionMetadata.subject).toBe(toolName);
      expect(definition?.requiredBackendCapabilities.length).toBeGreaterThan(0);
    }
  });

  it("projects the golden-flow registry into a runtime capability manifest", () => {
    const manifest = getGoldenFlowRunCapabilityManifest({
      runId: "run-1",
      availableToolIds: ["read_file", "bash", "git_status"],
    });

    expect(manifest.executionLocation).toBe("cloud_sandbox");
    expect(manifest.availableTools.map((tool) => tool.logicalName)).toEqual([
      "read_file",
      "bash",
      "git_status",
    ]);
    expect(manifest.availableTools).toContainEqual(
      expect.objectContaining({
        logicalName: "bash",
        availability: "approval_required",
        avoidWhen: expect.arrayContaining(["simple file inspection"]),
      }),
    );
    expect(manifest.unavailableCapabilities).toContainEqual(
      expect.objectContaining({ id: "desktop_local" }),
    );
  });

  it("builds a prompt-facing tool catalog snapshot from the manifest", () => {
    const snapshot = getGoldenFlowToolCatalogSnapshot({
      runId: "run-1",
      availableToolIds: ["read_file", "grep"],
    });

    expect(snapshot.tools).toEqual([
      expect.objectContaining({
        name: "read_file",
        preferredFor: ["file inspection", "line range reads"],
      }),
      expect.objectContaining({
        name: "grep",
        preferredFor: ["content search", "symbol or text discovery"],
      }),
    ]);
    expect(snapshot.unavailableCapabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "outside_workspace_files" }),
      ]),
    );
  });

  it("adapts legacy plugin responses into required ToolResult shape", async () => {
    const definition = getCodingToolDefinition("grep");
    const truncatedResult = await definition?.execute(
      { pattern: "TODO" },
      {
        async execute() {
          return {
            success: true,
            output: "src/index.ts:1:TODO",
            metadata: { totalMatches: 1 },
            truncated: true,
          };
        },
      },
    );
    const untruncatedResult = await definition?.execute(
      { pattern: "TODO" },
      {
        async execute() {
          return {
            success: true,
            output: "src/index.ts:1:TODO",
            metadata: { totalMatches: 1 },
          };
        },
      },
    );

    expect(truncatedResult).toEqual({
      title: "Grep Files",
      output: "src/index.ts:1:TODO",
      metadata: { totalMatches: 1 },
      truncated: true,
    });
    expect(untruncatedResult?.truncated).toBe(false);
  });

  it("enforces bounded scope by dropping non-floor tools", () => {
    const filtered = enforceGoldenFlowToolFloor(
      {
        read_file: {
          description: "custom read",
          parameters: {},
        } as unknown as import("ai").CoreTool,
        web_search: {
          description: "unsupported",
          parameters: {},
        } as unknown as import("ai").CoreTool,
      },
      {
        featureFlags: {
          ghCliLaneEnabled: true,
          ghCliCiEnabled: true,
          ghCliPrCommentEnabled: true,
        },
      },
    );

    expect(filtered.read_file?.description).toBe("custom read");
    expect(Object.keys(filtered)).toEqual(["read_file"]);
    expect("web_search" in filtered).toBe(false);
  });

  it("applies GitHub CLI lane feature flags to the tool floor", () => {
    const allDisabled = enforceGoldenFlowToolFloor(
      {},
      {
        featureFlags: {
          ghCliLaneEnabled: false,
          ghCliCiEnabled: false,
          ghCliPrCommentEnabled: false,
        },
      },
    );
    expect(allDisabled.github_cli_pr_checks_get).toBeUndefined();
    expect(allDisabled.github_cli_actions_run_get).toBeUndefined();
    expect(allDisabled.github_cli_actions_job_logs_get).toBeUndefined();
    expect(allDisabled.github_cli_pr_comment).toBeUndefined();

    const ciOnly = enforceGoldenFlowToolFloor(
      {},
      {
        featureFlags: {
          ghCliLaneEnabled: true,
          ghCliCiEnabled: true,
          ghCliPrCommentEnabled: false,
        },
      },
    );
    expect(ciOnly.github_cli_pr_checks_get).toBeUndefined();
    expect(ciOnly.github_cli_actions_run_get).toBeUndefined();
    expect(ciOnly.github_cli_actions_job_logs_get).toBeUndefined();
    expect(ciOnly.github_cli_pr_comment).toBeUndefined();

    const missingCiFlag = enforceGoldenFlowToolFloor(
      {},
      {
        featureFlags: {
          ghCliLaneEnabled: true,
          ghCliPrCommentEnabled: true,
        },
      },
    );
    expect(missingCiFlag.github_cli_pr_checks_get).toBeUndefined();
    expect(missingCiFlag.github_cli_actions_run_get).toBeUndefined();
    expect(missingCiFlag.github_cli_actions_job_logs_get).toBeUndefined();
    expect(missingCiFlag.github_cli_pr_comment).toBeUndefined();
  });

  it("validates tool inputs against canonical schemas", () => {
    const parsedGrep = validateGoldenFlowToolInput("grep", {
      pattern: "TODO",
      path: ".",
      maxResults: 5,
      caseSensitive: false,
      ignored: "field",
    });
    expect(parsedGrep).toEqual({
      pattern: "TODO",
      path: ".",
      maxResults: 5,
      caseSensitive: false,
    });

    const parsedRead = validateGoldenFlowToolInput("read_file", {
      path: "README.md",
      offset: 10,
      limit: 25,
    });
    expect(parsedRead).toEqual({
      path: "README.md",
      offset: 10,
      limit: 25,
    });

    expect(() =>
      validateGoldenFlowToolInput("grep", {
        pattern: "TODO",
        caseSensitive: "false",
      }),
    ).toThrow("Invalid grep input");
  });

  it("normalizes nullish input for tools that allow empty argument objects", () => {
    expect(validateGoldenFlowToolInput("git_status", null)).toEqual({});
    expect(validateGoldenFlowToolInput("git_stage", undefined)).toEqual({});
    expect(validateGoldenFlowToolInput("list_files", null)).toEqual({});
    expect(validateGoldenFlowToolInput("git_diff", undefined)).toEqual({});

    const registry = getGoldenFlowToolRegistry();
    expect(registry.git_status?.parameters.safeParse(null).success).toBe(true);
    expect(registry.git_stage?.parameters.safeParse(undefined).success).toBe(
      true,
    );
    expect(registry.list_files?.parameters.safeParse(null).success).toBe(true);
    expect(registry.git_diff?.parameters.safeParse(null).success).toBe(true);
  });

  it("requires single-line git commit messages", () => {
    expect(() =>
      validateGoldenFlowToolInput("git_commit", {
        message: "feat: subject\n\nbody line",
      }),
    ).toThrow("Commit message must be a single-line subject");
  });
});
