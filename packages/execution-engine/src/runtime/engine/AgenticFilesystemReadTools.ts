import {
  getCodingToolRoute,
  validateCodingToolInput,
  type CodingToolId,
} from "../tools/CodingToolRegistry.js";
import {
  extractExecutionFailure,
  formatExecutionResult,
} from "../agents/ResultFormatter.js";
import { validateSafePath } from "../agents/validation.js";
import type {
  RuntimeExecutionService,
  TaskInput,
  TaskResult,
} from "../types.js";
import {
  normalizeToolPath,
  validateToolPath,
} from "./ToolPathNormalization.js";

export async function executeReadFileTool(
  executionService: RuntimeExecutionService,
  taskId: string,
  taskInput: TaskInput,
): Promise<TaskResult> {
  const validatedInput = validateCodingToolInput("read_file", taskInput);
  const path = normalizeAndValidateReadPath(validatedInput.path);
  const payload: Record<string, unknown> = { path };
  if (validatedInput.offset !== undefined) {
    payload.offset = validatedInput.offset;
  }
  if (validatedInput.limit !== undefined) {
    payload.limit = validatedInput.limit;
  }

  return executeReadLaneTool(executionService, taskId, "read_file", payload);
}

export async function executeListFilesTool(
  executionService: RuntimeExecutionService,
  taskId: string,
  taskInput: TaskInput,
): Promise<TaskResult> {
  const validatedInput = validateCodingToolInput("list_files", taskInput);
  const path = validatedInput.path
    ? normalizeAndValidateDirectoryPath(validatedInput.path)
    : ".";
  return executeReadLaneTool(executionService, taskId, "list_files", { path });
}

export async function executeGlobTool(
  executionService: RuntimeExecutionService,
  taskId: string,
  taskInput: TaskInput,
): Promise<TaskResult> {
  const validatedInput = validateCodingToolInput("glob", taskInput);
  const payload: Record<string, unknown> = {
    pattern: validatedInput.pattern,
    path: normalizeAndValidateDirectoryPath(validatedInput.path ?? "."),
  };
  if (validatedInput.maxResults !== undefined) {
    payload.maxResults = validatedInput.maxResults;
  }
  return executeReadLaneTool(executionService, taskId, "glob", payload);
}

export async function executeGrepTool(
  executionService: RuntimeExecutionService,
  taskId: string,
  taskInput: TaskInput,
): Promise<TaskResult> {
  const validatedInput = validateCodingToolInput("grep", taskInput);
  const payload: Record<string, unknown> = {
    pattern: validatedInput.pattern,
    path: normalizeAndValidateDirectoryPath(validatedInput.path ?? "."),
  };
  if (validatedInput.glob) {
    payload.glob = validatedInput.glob;
  }
  if (validatedInput.caseSensitive !== undefined) {
    payload.caseSensitive = validatedInput.caseSensitive;
  }
  if (validatedInput.maxResults !== undefined) {
    payload.maxResults = validatedInput.maxResults;
  }
  return executeReadLaneTool(executionService, taskId, "grep", payload);
}

async function executeReadLaneTool(
  executionService: RuntimeExecutionService,
  taskId: string,
  toolName: "read_file" | "list_files" | "glob" | "grep",
  payload: Record<string, unknown>,
): Promise<TaskResult> {
  const result = await executeGatewayPlugin(executionService, toolName, payload);
  const failure = extractExecutionFailure(result);
  if (failure) {
    return buildFailureResult(taskId, failure);
  }
  return buildSuccessResult(taskId, formatExecutionResult(result));
}

function normalizeAndValidateReadPath(input: string): string {
  const path = normalizeToolPath(input);
  validateToolPath(path);
  validateSafePath(path);
  return path;
}

function normalizeAndValidateDirectoryPath(input: string): string {
  const path = normalizeToolPath(input);
  if (path !== ".") {
    validateSafePath(path);
  }
  return path;
}

async function executeGatewayPlugin(
  executionService: RuntimeExecutionService,
  toolName: CodingToolId,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const route = getCodingToolRoute(toolName);
  if (!route || route.plugin === "internal") {
    throw new Error(`No executable gateway route registered for ${toolName}`);
  }
  return executionService.execute(route.plugin, route.action, payload);
}

function buildSuccessResult(taskId: string, content: string): TaskResult {
  return {
    taskId,
    status: "DONE",
    output: { content },
    completedAt: new Date(),
  };
}

function buildFailureResult(taskId: string, message: string): TaskResult {
  return {
    taskId,
    status: "FAILED",
    error: { message },
    completedAt: new Date(),
  };
}
