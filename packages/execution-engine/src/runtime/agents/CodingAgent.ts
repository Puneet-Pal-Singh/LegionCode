// apps/brain/src/core/agents/CodingAgent.ts
// Phase 3D: Concrete agent for coding tasks (file ops, tests, shell, git)

import type {
  AgentCapability,
  ExecutionContext,
  SynthesisContext,
  AgentType,
  TaskResult,
  TaskInput,
} from "../types.js";
import type { Task } from "../task/index.js";
import type { Plan, PlanContext } from "../planner/index.js";
import { PlanSchema } from "../planner/index.js";
import safeRegex from "safe-regex";
import { BaseAgent } from "./BaseAgent.js";
import { validateSafePath, extractStructuredField } from "./validation.js";
import {
  getGoldenFlowToolRoute,
  isGoldenFlowToolName,
  isConcreteCommandInput,
  isConcretePathInput,
  isValidGitActionInput,
  type GoldenFlowToolName,
  type GoldenFlowToolInputByName,
  VALID_GIT_ACTIONS,
  validateGoldenFlowToolInput,
} from "../contracts/index.js";
import {
  extractExecutionFailure,
  formatExecutionResult,
  formatTaskOutput,
} from "./ResultFormatter.js";
import { buildGroundedTaskSummary } from "../engine/RunGroundedSummary.js";
import {
  normalizeWorkspaceShellCommand,
  resolveWorkspaceRelativeShellPath,
} from "../lib/WorkspaceShellCommand.js";

type LineMatcherPatternSource =
  | "external_user_input"
  | "deriveGrepPatternFromHint";

export class CodingAgent extends BaseAgent {
  readonly type: AgentType = "coding";

  async plan(context: PlanContext): Promise<Plan> {
    console.log(`[agents/coding] Generating plan for run ${context.run.id}`);

    const messages = this.buildPlanMessages(context.run, context.prompt);
    const result = await this.llmGateway.generateStructured({
      context: {
        runId: context.run.id,
        sessionId: context.run.sessionId,
        agentType: this.type,
        phase: "planning",
      },
      messages,
      schema: PlanSchema,
      model: context.run.input.modelId,
      providerId: context.run.input.providerId,
      temperature: 0.2,
    });

    console.log(
      `[agents/coding] Generated plan with ${result.object.tasks.length} tasks`,
    );
    return result.object as Plan;
  }

  async executeTask(
    task: Task,
    context: ExecutionContext,
  ): Promise<TaskResult> {
    console.log(
      `[agents/coding] Executing task ${task.id} (${task.type}) in run ${context.runId}`,
    );

    switch (task.type) {
      case "analyze":
        return this.executeAnalyze(task);
      case "edit":
        return this.executeEdit(task);
      case "test":
        return this.executeTest(task);
      case "shell":
        return this.executeShell(task);
      case "git":
        return this.executeGit(task);
      case "review":
        return this.executeReview(task, context);
      default:
        if (isGoldenFlowToolName(task.type)) {
          return this.executeGoldenFlowToolTask(task, task.type);
        }
        throw new UnsupportedTaskTypeError(String(task.type));
    }
  }

  async synthesize(context: SynthesisContext): Promise<string> {
    console.log(
      `[agents/coding] Synthesizing results for run ${context.runId}`,
    );

    const groundedSummary = buildGroundedTaskSummary(
      context.originalPrompt,
      context.completedTasks,
    );

    if (
      groundedSummary.audit.missingMutationEvidence &&
      groundedSummary.missingMutationSummary
    ) {
      console.warn(
        `[agents/coding] Missing mutation evidence for run ${context.runId}; returning guarded summary`,
      );
      return groundedSummary.missingMutationSummary;
    }

    try {
      const result = await this.llmGateway.generateText({
        context: {
          runId: context.runId,
          sessionId: context.sessionId,
          agentType: this.type,
          phase: "synthesis",
        },
        messages: [
          {
            role: "system",
            content:
              "Summarize coding run results using only the provided execution evidence.",
          },
          {
            role: "user",
            content: groundedSummary.evidencePrompt,
          },
        ],
        model: context.modelId,
        providerId: context.providerId,
      });
      if (looksLikeRawToolTranscript(result.text)) {
        console.warn(
          `[agents/coding] Synthesis returned raw tool transcript for run ${context.runId}; using grounded fallback`,
        );
        return groundedSummary.fallbackSummary;
      }
      return result.text;
    } catch (error) {
      console.warn(
        `[agents/coding] Falling back to grounded summary for run ${context.runId}`,
        error,
      );
      return groundedSummary.fallbackSummary;
    }
  }

  getCapabilities(): AgentCapability[] {
    return [
      { name: "file_read", description: "Read files from the workspace" },
      { name: "file_edit", description: "Edit and write files" },
      { name: "git_commit", description: "Perform git operations" },
      { name: "test_run", description: "Run test suites" },
      { name: "shell_execute", description: "Execute shell commands" },
    ];
  }

  protected getPlanSystemPrompt(): string {
    return `You are a coding assistant planner. Break down the user's coding request into atomic tasks.

Output a JSON object with this structure:
{
  "tasks": [
    { "id": "1", "type": "analyze|edit|test|review|git|shell", "description": "...", "dependsOn": [], "expectedOutput": "...", "input": {...} }
  ],
  "metadata": { "estimatedSteps": 3, "reasoning": "..." }
}

CRITICAL: Every task MUST have properly structured "input" fields. NEVER put descriptions/titles in the input - use concrete values only.

ANALYZE: MUST extract the actual file path to read
{ "type": "analyze", "description": "Read the README", "input": { "path": "README.md" } }
✗ WRONG: { "input": { "path": "Analyze the current workspace" } }

EDIT: MUST have both path AND the exact content to write
{ "type": "edit", "description": "Create new config file", "input": { "path": "config.json", "content": "{...}" } }
✗ WRONG: { "input": { "path": "src/app.ts", "content": "the new code" } }

TEST: MUST have the exact command to execute
{ "type": "test", "description": "Run tests", "input": { "command": "npm test -- src/service.test.ts" } }
✗ WRONG: { "input": { "command": "If tests fail, fix them" } }

SHELL: MUST have the exact shell command
{ "type": "shell", "description": "Check Node version", "input": { "command": "node --version" } }
✗ WRONG: { "input": { "command": "Check if node is installed" } }

GIT: MUST have the git action (git_commit, git_push, git_status, git_clone, git_branch_list, etc)
{ "type": "git", "description": "Commit changes", "input": { "action": "git_commit", "message": "feat: add new feature" } }
✗ WRONG: { "input": { "action": "commit changes" } }

IMPORTANT TOOL ROUTING:
- NEVER use shell tasks for git commands (git ...)
- Use task type "git" for repository status/diff/branch/commit actions
- Valid git actions: status, diff, stage, unstage, commit, push, git_clone, git_diff, git_commit, git_push, git_pull, git_fetch, git_branch_create, git_branch_switch, git_branch_list, git_stage, git_status, git_config
- Use analyze tasks for file inspection and directory listing

REVIEW: Only LLM task, no input needed - just use description

VALIDATION RULES:
1. Every non-review task MUST have a non-empty "input" object
2. ANALYZE tasks: input.path must be a real file path (max 500 chars)
3. EDIT tasks: input.path AND input.content must both be provided
4. TEST/SHELL: input.command must be an executable command (max 500 chars)
5. GIT: input.action must be a valid git action (git_commit, git_push, git_status, git_clone, etc)
6. NEVER use task description or placeholders in input fields
7. If the user only asks to inspect/read/check, NEVER create edit tasks
8. Only create edit tasks when the user explicitly asks to modify files
9. Start with "analyze" tasks to understand codebase
10. End with "test" tasks only when code changes were requested
11. Keep tasks atomic and under 20 total`;
  }

  private async executeAnalyze(task: Task): Promise<TaskResult> {
    const rawPath = extractStructuredField(task.input, "path");
    if (!rawPath) {
      throw new TaskInputError("analyze", "Missing 'path' field in task input");
    }
    const path = normalizeTaskPath(rawPath);
    if (requiresDiscoveryBeforeRead(path)) {
      return this.executeDiscoveryForAmbiguousTarget(task.id, path);
    }
    validateTaskPath(path);
    validateSafePath(path);
    return this.executeReadFileWithFallback(task.id, path);
  }

  private async executeEdit(task: Task): Promise<TaskResult> {
    const rawPath = extractStructuredField(task.input, "path");
    if (!rawPath) {
      throw new TaskInputError("edit", "Missing 'path' field in task input");
    }
    const path = normalizeTaskPath(rawPath);
    validateTaskPath(path);
    validateSafePath(path);

    const content = extractStructuredField(task.input, "content");
    if (!content) {
      throw new TaskInputError("edit", "Missing 'content' field in task input");
    }

    const result = await this.executionService.execute(
      "filesystem",
      "write_file",
      {
        path,
        content,
      },
    );
    const failure = extractExecutionFailure(result);
    if (failure) {
      return this.buildFailureResult(task.id, failure);
    }

    return this.buildSuccessResult(task.id, formatExecutionResult(result));
  }

  private async executeTest(task: Task): Promise<TaskResult> {
    const command = extractStructuredField(task.input, "command");
    if (!command) {
      throw new TaskInputError("test", "Missing 'command' field in task input");
    }
    validateShellCommand(command);

    const result = await this.executionService.execute("node", "run", {
      command,
    });
    const failure = extractExecutionFailure(result);
    if (failure) {
      return this.buildFailureResult(task.id, failure);
    }

    return this.buildSuccessResult(task.id, formatExecutionResult(result));
  }

  private async executeShell(task: Task): Promise<TaskResult> {
    const command = extractStructuredField(task.input, "command");
    if (!command) {
      throw new TaskInputError(
        "shell",
        "Missing 'command' field in task input",
      );
    }
    return this.executeCommandWithGuards(task.id, command);
  }

  private async executeGit(task: Task): Promise<TaskResult> {
    const action = extractStructuredField(task.input, "action");
    if (!action) {
      throw new TaskInputError(
        "git",
        "Missing 'action' field in task input (e.g., 'commit', 'push', 'status')",
      );
    }
    validateGitAction(action);

    const result = await this.executionService.execute("git", action, {
      message:
        extractStructuredField(task.input, "message") ?? task.input.description,
    });
    const failure = extractExecutionFailure(result);
    if (failure) {
      return this.buildFailureResult(task.id, failure);
    }

    return this.buildSuccessResult(task.id, formatExecutionResult(result));
  }

  private async executeGoldenFlowToolTask(
    task: Task,
    toolName: GoldenFlowToolName,
  ): Promise<TaskResult> {
    switch (toolName) {
      case "read_file":
        return this.executeReadFileTool(task);
      case "list_files":
        return this.executeListFilesTool(task);
      case "write_file":
        return this.executeWriteFileTool(task);
      case "bash":
        return this.executeBashTool(task);
      case "git_stage":
        return this.executeGitStageTool(task);
      case "git_commit":
        return this.executeGitCommitTool(task);
      case "git_push":
        return this.executeGitPushTool(task);
      case "git_pull":
        return this.executeGitPullTool(task);
      case "git_create_pull_request":
        return this.executeGitCreatePullRequestTool(task);
      case "git_branch_create":
        return this.executeGitBranchCreateTool(task);
      case "git_branch_switch":
        return this.executeGitBranchSwitchTool(task);
      case "git_status":
        return this.executeGitStatusTool(task);
      case "git_diff":
        return this.executeGitDiffTool(task);
      case "glob":
        return this.executeGlobTool(task);
      case "grep":
        return this.executeGrepTool(task);
      default:
        throw new UnsupportedTaskTypeError(toolName);
    }
  }

  private async executeReadFileTool(task: Task): Promise<TaskResult> {
    const validatedInput = this.validateGoldenFlowInput(
      "read_file",
      task.input,
    );
    const path = normalizeTaskPath(validatedInput.path);
    if (requiresDiscoveryBeforeRead(path)) {
      return this.executeDiscoveryForAmbiguousTarget(task.id, path);
    }
    validateTaskPath(path);
    validateSafePath(path);
    return this.executeReadFileWithFallback(task.id, path);
  }

  private async executeListFilesTool(task: Task): Promise<TaskResult> {
    const validatedInput = this.validateGoldenFlowInput(
      "list_files",
      task.input,
    );
    const path = validatedInput.path
      ? normalizeTaskPath(validatedInput.path)
      : ".";
    if (path !== ".") {
      validateSafePath(path);
    }
    return this.listDirectory(task.id, path);
  }

  private async executeWriteFileTool(task: Task): Promise<TaskResult> {
    const validatedInput = this.validateGoldenFlowInput(
      "write_file",
      task.input,
    );
    const path = normalizeTaskPath(validatedInput.path);
    validateTaskPath(path);
    validateSafePath(path);
    const { content } = validatedInput;
    const existingContent = await this.readExistingFileContent(path);

    const result = await this.executeGatewayPlugin("write_file", {
      path,
      content,
    });
    const failure = extractExecutionFailure(result);
    if (failure) {
      return this.buildFailureResult(task.id, failure);
    }
    return this.buildSuccessResult(task.id, formatExecutionResult(result), {
      activity: buildWriteActivityMetadata(path, existingContent, content),
    });
  }

  private async executeBashTool(task: Task): Promise<TaskResult> {
    const validatedInput = this.validateGoldenFlowInput("bash", task.input);
    return this.executeCommandWithGuards(
      task.id,
      validatedInput.command,
      validatedInput.cwd,
    );
  }

  private async executeGitStatusTool(task: Task): Promise<TaskResult> {
    this.validateGoldenFlowInput("git_status", task.input);
    const result = await this.executeGatewayPlugin("git_status", {});
    const failure = extractExecutionFailure(result);
    if (failure) {
      return this.buildFailureResult(task.id, failure);
    }
    return this.buildSuccessResult(task.id, formatExecutionResult(result));
  }

  private async executeGitStageTool(task: Task): Promise<TaskResult> {
    const validatedInput = this.validateGoldenFlowInput("git_stage", task.input);
    const payload: Record<string, unknown> = {};
    if (validatedInput.files && validatedInput.files.length > 0) {
      payload.files = validatedInput.files.map((file) => {
        const normalizedPath = normalizeTaskPath(file);
        validateSafePath(normalizedPath);
        return normalizedPath;
      });
    }

    const result = await this.executeGatewayPlugin("git_stage", payload);
    const failure = extractExecutionFailure(result);
    if (failure) {
      return this.buildFailureResult(task.id, failure);
    }
    return this.buildSuccessResult(task.id, formatExecutionResult(result));
  }

  private async executeGitCommitTool(task: Task): Promise<TaskResult> {
    const validatedInput = this.validateGoldenFlowInput(
      "git_commit",
      task.input,
    );
    const payload: Record<string, unknown> = {
      message: validatedInput.message.trim(),
    };
    if (validatedInput.files && validatedInput.files.length > 0) {
      payload.files = validatedInput.files.map((file) => {
        const normalizedPath = normalizeTaskPath(file);
        validateSafePath(normalizedPath);
        return normalizedPath;
      });
    }
    if (validatedInput.authorName) {
      payload.authorName = validatedInput.authorName.trim();
    }
    if (validatedInput.authorEmail) {
      payload.authorEmail = validatedInput.authorEmail.trim();
    }

    const result = await this.executeGatewayPlugin("git_commit", payload);
    const failure = extractExecutionFailure(result);
    if (failure) {
      return this.buildFailureResult(task.id, failure);
    }
    return this.buildSuccessResult(task.id, formatExecutionResult(result));
  }

  private async executeGitPushTool(task: Task): Promise<TaskResult> {
    const validatedInput = this.validateGoldenFlowInput("git_push", task.input);
    const payload: Record<string, unknown> = {};
    if (validatedInput.remote) {
      payload.remote = validatedInput.remote.trim();
    }
    if (validatedInput.branch) {
      payload.branch = validatedInput.branch.trim();
    }

    const result = await this.executeGatewayPlugin("git_push", payload);
    const failure = extractExecutionFailure(result);
    if (failure) {
      return this.buildFailureResult(task.id, failure);
    }
    return this.buildSuccessResult(task.id, formatExecutionResult(result));
  }

  private async executeGitPullTool(task: Task): Promise<TaskResult> {
    const validatedInput = this.validateGoldenFlowInput("git_pull", task.input);
    const payload: Record<string, unknown> = {};
    if (validatedInput.remote) {
      payload.remote = validatedInput.remote.trim();
    }
    if (validatedInput.branch) {
      payload.branch = validatedInput.branch.trim();
    }

    const result = await this.executeGatewayPlugin("git_pull", payload);
    const failure = extractExecutionFailure(result);
    if (failure) {
      return this.buildFailureResult(task.id, failure);
    }
    return this.buildSuccessResult(task.id, formatExecutionResult(result));
  }

  private async executeGitCreatePullRequestTool(
    task: Task,
  ): Promise<TaskResult> {
    const validatedInput = this.validateGoldenFlowInput(
      "git_create_pull_request",
      task.input,
    );
    const payload: Record<string, unknown> = {
      owner: validatedInput.owner.trim(),
      repo: validatedInput.repo.trim(),
      title: validatedInput.title.trim(),
    };
    if (validatedInput.body) {
      payload.body = validatedInput.body.trim();
    }
    if (validatedInput.base) {
      payload.base = validatedInput.base.trim();
    }

    const result = await this.executeGatewayPlugin(
      "git_create_pull_request",
      payload,
    );
    const failure = extractExecutionFailure(result);
    if (failure) {
      return this.buildFailureResult(task.id, failure);
    }
    return this.buildSuccessResult(task.id, formatExecutionResult(result));
  }

  private async executeGitBranchCreateTool(task: Task): Promise<TaskResult> {
    const validatedInput = this.validateGoldenFlowInput(
      "git_branch_create",
      task.input,
    );
    const result = await this.executeGatewayPlugin("git_branch_create", {
      branch: validatedInput.branch.trim(),
    });
    const failure = extractExecutionFailure(result);
    if (failure) {
      return this.buildFailureResult(task.id, failure);
    }
    return this.buildSuccessResult(task.id, formatExecutionResult(result));
  }

  private async executeGitBranchSwitchTool(task: Task): Promise<TaskResult> {
    const validatedInput = this.validateGoldenFlowInput(
      "git_branch_switch",
      task.input,
    );
    const result = await this.executeGatewayPlugin("git_branch_switch", {
      branch: validatedInput.branch.trim(),
    });
    const failure = extractExecutionFailure(result);
    if (failure) {
      return this.buildFailureResult(task.id, failure);
    }
    return this.buildSuccessResult(task.id, formatExecutionResult(result));
  }

  private async executeGitDiffTool(task: Task): Promise<TaskResult> {
    const validatedInput = this.validateGoldenFlowInput("git_diff", task.input);
    const payload: Record<string, unknown> = {};
    const path = validatedInput.path;
    if (path) {
      const normalizedPath = normalizeTaskPath(path);
      validateSafePath(normalizedPath);
      payload.path = normalizedPath;
    }

    if (typeof validatedInput.staged === "boolean") {
      payload.staged = validatedInput.staged;
    }

    const result = await this.executeGatewayPlugin("git_diff", payload);
    const failure = extractExecutionFailure(result);
    if (failure) {
      return this.buildFailureResult(task.id, failure);
    }
    return this.buildSuccessResult(task.id, formatExecutionResult(result));
  }

  private async executeGlobTool(task: Task): Promise<TaskResult> {
    const validatedInput = this.validateGoldenFlowInput("glob", task.input);
    const { pattern } = validatedInput;
    const startPath = validatedInput.path ?? ".";
    if (startPath !== ".") {
      validateSafePath(startPath);
    }
    const maxResults = validatedInput.maxResults ?? 50;
    const matches = await this.findGlobMatches(pattern, startPath, maxResults);
    const output =
      matches.length > 0
        ? matches.join("\n")
        : `No files matched glob pattern "${pattern}" from ${startPath}.`;
    return this.buildSuccessResult(task.id, output);
  }

  private async executeGrepTool(task: Task): Promise<TaskResult> {
    const validatedInput = this.validateGoldenFlowInput("grep", task.input);
    const { pattern } = validatedInput;
    const startPath = validatedInput.path ?? ".";
    if (startPath !== ".") {
      validateSafePath(startPath);
    }
    const globPattern = validatedInput.glob;
    const caseSensitive = validatedInput.caseSensitive ?? false;
    const maxResults = validatedInput.maxResults ?? 25;
    const matches = await this.findGrepMatches({
      pattern,
      startPath,
      globPattern,
      caseSensitive,
      maxResults,
      patternSource: "external_user_input",
    });
    const output =
      matches.length > 0
        ? matches.join("\n")
        : `No matches found for "${pattern}" from ${startPath}.`;
    return this.buildSuccessResult(task.id, output);
  }

  private async executeReadFileWithFallback(
    taskId: string,
    path: string,
  ): Promise<TaskResult> {
    const readResult = await this.executeGatewayPlugin("read_file", { path });
    const readFailure = extractExecutionFailure(readResult);
    if (!readFailure) {
      return this.buildSuccessResult(taskId, formatExecutionResult(readResult));
    }

    if (looksLikeDirectoryError(readFailure)) {
      return this.listDirectory(taskId, path, true);
    }

    if (
      looksLikeMissingTargetError(readFailure) &&
      requiresDiscoveryBeforeRead(path)
    ) {
      return this.executeDiscoveryForAmbiguousTarget(taskId, path);
    }

    return this.buildFailureResult(taskId, readFailure);
  }

  private async executeDiscoveryForAmbiguousTarget(
    taskId: string,
    targetHint: string,
  ): Promise<TaskResult> {
    const sections: string[] = [
      `Target "${targetHint}" is ambiguous. Running discovery first.`,
    ];
    const topLevel = await this.executeGatewayPlugin("list_files", {
      path: ".",
    });
    const topLevelFailure = extractExecutionFailure(topLevel);
    if (!topLevelFailure) {
      sections.push(`Top-level files:\n${formatExecutionResult(topLevel)}`);
    }

    const globPattern = deriveGlobPatternFromHint(targetHint);
    if (globPattern) {
      const globMatches = await this.findGlobMatches(globPattern, ".", 15);
      if (globMatches.length > 0) {
        sections.push(
          `Glob matches (${globPattern}):\n${globMatches.join("\n")}`,
        );
      }
    }

    const grepNeedle = deriveGrepPatternFromHint(targetHint);
    if (grepNeedle) {
      const grepMatches = await this.findGrepMatches({
        pattern: grepNeedle,
        startPath: ".",
        globPattern: deriveGlobPatternFromHint(targetHint) ?? undefined,
        caseSensitive: false,
        maxResults: 10,
        patternSource: "deriveGrepPatternFromHint",
      });
      if (grepMatches.length > 0) {
        sections.push(
          `Grep matches (${grepNeedle}):\n${grepMatches.join("\n")}`,
        );
      }
    }

    if (sections.length === 1) {
      sections.push(
        "No candidate files were discovered in the current workspace.",
      );
    }
    return this.buildSuccessResult(taskId, sections.join("\n\n"));
  }

  private async listDirectory(
    taskId: string,
    path: string,
    fromDirectoryRead = false,
  ): Promise<TaskResult> {
    const result = await this.executeGatewayPlugin("list_files", { path });
    const failure = extractExecutionFailure(result);
    if (failure) {
      return this.buildFailureResult(taskId, failure);
    }
    const content = formatExecutionResult(result);
    if (!fromDirectoryRead) {
      return this.buildSuccessResult(taskId, content);
    }
    return this.buildSuccessResult(
      taskId,
      `Requested path is a directory. Listing ${path}:\n${content}`,
    );
  }

  private async executeCommandWithGuards(
    taskId: string,
    command: string,
    cwd?: string,
  ): Promise<TaskResult> {
    validateShellCommand(command);
    const normalizedInput = normalizeWorkspaceShellCommand({
      command,
      cwd: cwd ? normalizeTaskPath(cwd) : undefined,
    });
    const normalizedCommand = normalizedInput.command.trim();
    const normalizedCwd = normalizedInput.cwd
      ? normalizeTaskPath(normalizedInput.cwd)
      : undefined;
    if (/^ls(\s|$)/i.test(normalizedCommand)) {
      const path = resolveWorkspaceRelativeShellPath(
        normalizedCwd,
        extractDirectoryFromLsCommand(normalizedCommand),
      );
      if (path !== ".") {
        validateSafePath(path);
      }
      return this.listDirectory(taskId, path);
    }

    if (normalizedCwd && normalizedCwd !== ".") {
      validateSafePath(normalizedCwd);
    }

    const result = await this.executeGatewayPlugin("bash", {
      command: normalizedCommand,
      cwd: normalizedCwd,
    });
    const failure = extractExecutionFailure(result);
    if (failure) {
      return this.buildFailureResult(taskId, failure);
    }
    return this.buildSuccessResult(taskId, formatExecutionResult(result));
  }

  private async executeGatewayPlugin(
    toolName: GoldenFlowToolName,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    const route = getGoldenFlowToolRoute(toolName);
    if (!route) {
      throw new TaskInputError(
        toolName,
        `No gateway route registered for ${toolName}`,
      );
    }
    if (route.plugin === "internal") {
      throw new TaskInputError(
        toolName,
        `Tool ${toolName} is internal and cannot be sent to plugin execution`,
      );
    }
    return this.executionService.execute(route.plugin, route.action, payload);
  }

  private async readExistingFileContent(path: string): Promise<string> {
    const readResult = await this.executeGatewayPlugin("read_file", { path });
    const failure = extractExecutionFailure(readResult);
    if (failure) {
      return "";
    }
    return formatExecutionResult(readResult);
  }

  private validateGoldenFlowInput<T extends GoldenFlowToolName>(
    toolName: T,
    input: TaskInput,
  ): GoldenFlowToolInputByName[T] {
    try {
      return validateGoldenFlowToolInput(toolName, input);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Invalid tool input";
      throw new TaskInputError(toolName, message);
    }
  }

  private async findGlobMatches(
    pattern: string,
    startPath: string,
    maxResults: number,
  ): Promise<string[]> {
    const scanLimit = Math.max(maxResults * 3, 60);
    const files = await this.collectWorkspaceFiles(startPath, scanLimit, 4);
    const matcher = buildGlobMatcher(pattern);
    return files.filter((filePath) => matcher(filePath)).slice(0, maxResults);
  }

  private async findGrepMatches(input: {
    pattern: string;
    startPath: string;
    globPattern?: string;
    caseSensitive: boolean;
    maxResults: number;
    patternSource: LineMatcherPatternSource;
  }): Promise<string[]> {
    const scanLimit = Math.max(input.maxResults * 4, 80);
    const candidates = input.globPattern
      ? await this.findGlobMatches(
          input.globPattern,
          input.startPath,
          scanLimit,
        )
      : await this.collectWorkspaceFiles(input.startPath, scanLimit, 4);
    const matches: string[] = [];
    const lineMatcher = buildLineMatcher(
      input.pattern,
      input.caseSensitive,
      input.patternSource,
    );

    for (const filePath of candidates) {
      if (matches.length >= input.maxResults) {
        break;
      }
      const readResult = await this.executeGatewayPlugin("read_file", {
        path: filePath,
      });
      const failure = extractExecutionFailure(readResult);
      if (failure) {
        continue;
      }
      const content = formatExecutionResult(readResult);
      if (content.includes("[BINARY_FILE_DETECTED]")) {
        continue;
      }
      const lines = content.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        if (matches.length >= input.maxResults) {
          break;
        }
        const line = lines[index] ?? "";
        if (lineMatcher(line)) {
          matches.push(`${filePath}:${index + 1}: ${line}`);
        }
      }
    }
    return matches;
  }

  private async collectWorkspaceFiles(
    startPath: string,
    maxFiles: number,
    maxDepth: number,
  ): Promise<string[]> {
    const discovered = new Set<string>();
    const queue: Array<{ path: string; depth: number }> = [
      { path: startPath, depth: 0 },
    ];

    while (queue.length > 0 && discovered.size < maxFiles) {
      const current = queue.shift();
      if (!current) {
        break;
      }
      const listResult = await this.executeGatewayPlugin("list_files", {
        path: current.path,
      });
      const listFailure = extractExecutionFailure(listResult);
      if (listFailure) {
        continue;
      }

      const entries = parseDirectoryEntries(formatExecutionResult(listResult));
      for (const entry of entries) {
        if (entry.endsWith("/")) {
          if (current.depth >= maxDepth) {
            continue;
          }
          const dirPath = joinRelativePath(current.path, entry.slice(0, -1));
          queue.push({ path: dirPath, depth: current.depth + 1 });
          continue;
        }
        discovered.add(joinRelativePath(current.path, entry));
        if (discovered.size >= maxFiles) {
          break;
        }
      }
    }

    return Array.from(discovered);
  }

  private async executeReview(
    task: Task,
    context: ExecutionContext,
  ): Promise<TaskResult> {
    const result = await this.llmGateway.generateText({
      context: {
        runId: task.runId,
        sessionId: context.sessionId,
        taskId: task.id,
        agentType: this.type,
        phase: "task",
      },
      messages: [
        {
          role: "system",
          content: "Review the following code and provide feedback.",
        },
        { role: "user", content: task.input.description },
      ],
      model: context.modelId,
      providerId: context.providerId,
    });
    return this.buildSuccessResult(task.id, result.text);
  }

  private buildSuccessResult(
    taskId: string,
    content: string,
    metadata?: Record<string, unknown>,
  ): TaskResult {
    return {
      taskId,
      status: "DONE",
      output: {
        content,
        metadata,
      },
      completedAt: new Date(),
    };
  }

  private buildFailureResult(taskId: string, message: string): TaskResult {
    return {
      taskId,
      status: "FAILED",
      error: { message },
      completedAt: new Date(),
    };
  }
}

function validateGitAction(action: string): void {
  if (!isValidGitActionInput(action)) {
    throw new TaskInputError(
      "git",
      `Invalid git action: "${action}". Allowed: ${VALID_GIT_ACTIONS.join(", ")}`,
    );
  }
}

function validateShellCommand(command: string): void {
  if (!isConcreteCommandInput(command)) {
    throw new TaskInputError(
      "shell",
      "Shell command must be a concrete non-empty command",
    );
  }
}

function buildWriteActivityMetadata(
  path: string,
  previousContent: string,
  nextContent: string,
): Record<string, unknown> {
  const additions = countChangedLines(nextContent, previousContent);
  const deletions = countChangedLines(previousContent, nextContent);
  return {
    family: "edit",
    filePath: path,
    additions,
    deletions,
    diffPreview: buildDiffPreview(previousContent, nextContent),
    restorationContent: nextContent,
  };
}

function countChangedLines(source: string, comparison: string): number {
  const sourceLines = splitLines(source);
  const comparisonLines = new Set(splitLines(comparison));
  return sourceLines.filter((line) => !comparisonLines.has(line)).length;
}

function buildDiffPreview(
  previousContent: string,
  nextContent: string,
): string {
  const previousLines = splitLines(previousContent);
  const nextLines = splitLines(nextContent);
  const previewLines: string[] = [];

  for (const line of nextLines) {
    if (!previousLines.includes(line)) {
      previewLines.push(`+ ${line}`);
    }
    if (previewLines.length >= 6) {
      break;
    }
  }

  for (const line of previousLines) {
    if (!nextLines.includes(line)) {
      previewLines.push(`- ${line}`);
    }
    if (previewLines.length >= 10) {
      break;
    }
  }

  return previewLines.join("\n");
}

function splitLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function normalizeTaskPath(input: string): string {
  const trimmed = input.trim().replace(/^['"`]+|['"`]+$/g, "");
  const withoutMention = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  const cleaned = withoutMention.replace(/[?!,;:]+$/g, "");

  const normalizedLower = cleaned.toLowerCase();
  const aliases: Record<string, string> = {
    readme: "README.md",
    "readme.md": "README.md",
  };

  return aliases[normalizedLower] ?? cleaned;
}

function validateTaskPath(path: string): void {
  if (!isConcretePathInput(path)) {
    throw new TaskInputError(
      "path",
      "Task path must be a concrete non-empty file path",
    );
  }
}

function looksLikeDirectoryError(message: string): boolean {
  return /is a directory/i.test(message);
}

function looksLikeMissingTargetError(message: string): boolean {
  return /no such file or directory|file does not exist|path .* not found/i.test(
    message,
  );
}

function looksLikeRawToolTranscript(value: string): boolean {
  return /<tool_call>|<\/tool_call>|<tool_calls>|<\/tool_calls>|<parameters>|<\/parameters>/i.test(
    value,
  );
}

function requiresDiscoveryBeforeRead(path: string): boolean {
  if (!isConcretePathInput(path)) {
    return true;
  }
  return /^(this|that|the|a|an)?\s*(file|files|repo|repository|project|code|folder|directory)$/i.test(
    path.trim(),
  );
}

function extractDirectoryFromLsCommand(command: string): string {
  const segments = command.split(/\s+/).slice(1);
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const segment = segments[i];
    if (!segment || segment.startsWith("-")) {
      continue;
    }
    return segment;
  }
  return ".";
}

function deriveGlobPatternFromHint(targetHint: string): string | null {
  const normalized = targetHint.trim().toLowerCase();
  if (/readme/.test(normalized)) {
    return "**/*readme*";
  }
  const extensionMatch = normalized.match(/\.([a-z0-9]{1,8})\b/i);
  if (extensionMatch?.[1]) {
    return `**/*.${extensionMatch[1]}`;
  }
  if (normalized.includes("test")) {
    return "**/*test*";
  }
  return null;
}

function deriveGrepPatternFromHint(targetHint: string): string | null {
  const words = targetHint
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/[^a-zA-Z0-9_.-]/g, ""))
    .filter((word) => word.length >= 4);
  return words[0] ?? null;
}

function parseDirectoryEntries(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !line.startsWith("... and ") &&
        !line.startsWith("Total:"),
    );
}

function joinRelativePath(basePath: string, entry: string): string {
  const normalizedBase = basePath
    .trim()
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
  const normalizedEntry = entry.trim().replace(/^\.\/+/, "");
  if (!normalizedBase || normalizedBase === ".") {
    return normalizedEntry;
  }
  return `${normalizedBase}/${normalizedEntry}`;
}

function buildGlobMatcher(pattern: string): (value: string) => boolean {
  const normalized = pattern.trim();
  const source: string[] = ["^"];
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized.charAt(index);
    const next = normalized.charAt(index + 1);
    if (char === "*" && next === "*") {
      source.push(".*");
      index += 1;
      continue;
    }
    if (char === "*") {
      source.push("[^/]*");
      continue;
    }
    if (char === "?") {
      source.push("[^/]");
      continue;
    }
    source.push(escapeRegexChar(char));
  }
  source.push("$");
  const matcher = new RegExp(source.join(""), "i");
  return (value: string) => matcher.test(value);
}

const MAX_UNTRUSTED_REGEX_PATTERN_LENGTH = 200;
const MAX_REGEX_COMPILE_BUDGET_MS = 10;
const MAX_REGEX_TEST_BUDGET_MS = 10;
const MAX_REGEX_TEST_INPUT_LENGTH = 2_000;

function buildLineMatcher(
  pattern: string,
  caseSensitive: boolean,
  patternSource: LineMatcherPatternSource,
): (line: string) => boolean {
  const substringMatcher = buildSubstringMatcher(pattern, caseSensitive);
  const skipExternalScreening = patternSource === "deriveGrepPatternFromHint";
  if (!skipExternalScreening && !isUserRegexPatternSafe(pattern)) {
    return substringMatcher;
  }

  const flags = caseSensitive ? "" : "i";
  try {
    const regex = compileRegexWithBudget(pattern, flags);
    let disableRegex = false;
    return (line: string) => {
      if (disableRegex) {
        return substringMatcher(line);
      }
      const candidate =
        line.length > MAX_REGEX_TEST_INPUT_LENGTH
          ? line.slice(0, MAX_REGEX_TEST_INPUT_LENGTH)
          : line;
      const startedAt = Date.now();
      const matched = regex.test(candidate);
      if (Date.now() - startedAt > MAX_REGEX_TEST_BUDGET_MS) {
        disableRegex = true;
        return substringMatcher(line);
      }
      return matched;
    };
  } catch {
    return substringMatcher;
  }
}

function compileRegexWithBudget(pattern: string, flags: string): RegExp {
  const startedAt = Date.now();
  const regex = new RegExp(pattern, flags);
  if (Date.now() - startedAt > MAX_REGEX_COMPILE_BUDGET_MS) {
    throw new Error("Regex compile budget exceeded");
  }
  return regex;
}

function isUserRegexPatternSafe(pattern: string): boolean {
  if (
    pattern.length === 0 ||
    pattern.length > MAX_UNTRUSTED_REGEX_PATTERN_LENGTH
  ) {
    return false;
  }
  return safeRegex(pattern);
}

function buildSubstringMatcher(
  pattern: string,
  caseSensitive: boolean,
): (line: string) => boolean {
  const needle = caseSensitive ? pattern : pattern.toLowerCase();
  return (line: string) => {
    const haystack = caseSensitive ? line : line.toLowerCase();
    return haystack.includes(needle);
  };
}

function escapeRegexChar(char: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
}

export class UnsupportedTaskTypeError extends Error {
  constructor(taskType: string) {
    super(`[agents/coding] Unsupported task type: ${taskType}`);
    this.name = "UnsupportedTaskTypeError";
  }
}

export class TaskInputError extends Error {
  constructor(taskType: string, message: string) {
    super(`[agents/coding] ${taskType}: ${message}`);
    this.name = "TaskInputError";
  }
}
