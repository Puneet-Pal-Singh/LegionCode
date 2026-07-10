import type { RunCapabilityManifest } from "../capabilities/RuntimeCapabilityManifest.js";
import {
  codingToolRegistry,
  type ToolDefinition,
} from "../tools/CodingToolRegistry.js";
import type {
  RuntimeExecutionService,
  TaskInput,
  TaskResult,
} from "../types.js";
import {
  RuntimeWorkspaceScope,
  RuntimeWorkspaceScopeError,
} from "./RuntimeWorkspaceScope.js";

export type RuntimeToolExecutionResult =
  | { readonly kind: "completed"; readonly result: TaskResult }
  | {
      readonly kind: "failed";
      readonly result: TaskResult;
      readonly code:
        | "tool_not_registered"
        | "tool_unavailable"
        | "invalid_tool_input"
        | "invalid_workspace_path"
        | "workspace_escape_denied"
        | "executor_failed";
      readonly retryable: boolean;
    }
  | { readonly kind: "cancelled"; readonly result: TaskResult };

export interface RuntimeToolGatewayInput {
  readonly taskId: string;
  readonly toolName: string;
  readonly toolInput: TaskInput;
  readonly onOutput?: (chunk: {
    message: string;
    source?: "stdout" | "stderr";
    timestamp?: number;
  }) => Promise<void> | void;
  readonly isCancelled?: () => boolean | Promise<boolean>;
}

/** Canonical registry/manifest/scope tool dispatch for kernel turns. */
export class RuntimeToolGateway {
  constructor(
    private readonly input: {
      readonly executor: RuntimeExecutionService;
      readonly manifest: RunCapabilityManifest;
      readonly scope: RuntimeWorkspaceScope;
    },
  ) {}

  async execute(
    input: RuntimeToolGatewayInput,
  ): Promise<RuntimeToolExecutionResult> {
    if (await input.isCancelled?.()) {
      return {
        kind: "cancelled",
        result: {
          taskId: input.taskId,
          status: "CANCELLED",
          error: {
            code: "turn_cancelled",
            message: "Tool execution was cancelled with its run.",
          },
          completedAt: new Date(),
        },
      };
    }
    const definition = codingToolRegistry.getDefinition(input.toolName);
    if (!definition) {
      return this.failure(
        input.taskId,
        "tool_not_registered",
        `Tool "${input.toolName}" is not registered.`,
        false,
      );
    }
    if (!this.isAvailable(definition)) {
      return this.failure(
        input.taskId,
        "tool_unavailable",
        `Tool "${definition.id}" is unavailable for this run.`,
        false,
      );
    }

    const parsed = definition.inputSchema.safeParse(input.toolInput);
    if (!parsed.success) {
      return this.failure(
        input.taskId,
        "invalid_tool_input",
        `Input for tool "${definition.id}" does not match its registered schema.`,
        false,
      );
    }

    let toolInput: Record<string, unknown>;
    try {
      toolInput = this.input.scope.normalizeToolInput(
        parsed.data as Record<string, unknown>,
      );
    } catch (error) {
      if (error instanceof RuntimeWorkspaceScopeError) {
        return this.failure(input.taskId, error.code, error.message, false);
      }
      throw error;
    }

    try {
      const result = await definition.execute(toolInput, {
        execute: async (plugin, action, payload) =>
          await this.input.executor.execute(plugin, action, payload, {
            scope: this.input.scope.executionScope,
            onOutput: input.onOutput,
          }),
      });
      if (await input.isCancelled?.()) {
        return {
          kind: "cancelled",
          result: {
            taskId: input.taskId,
            status: "CANCELLED",
            error: {
              code: "turn_cancelled",
              message: "Tool execution was cancelled with its run.",
            },
            completedAt: new Date(),
          },
        };
      }
      if (result.metadata.success === false) {
        return this.failure(
          input.taskId,
          "executor_failed",
          result.output,
          isRetryable(result.metadata),
        );
      }
      return {
        kind: "completed",
        result: {
          taskId: input.taskId,
          status: "DONE",
          output: { content: result.output, metadata: result.metadata },
          completedAt: new Date(),
        },
      };
    } catch (error) {
      return this.failure(
        input.taskId,
        "executor_failed",
        error instanceof Error ? error.message : "Tool executor failed.",
        false,
      );
    }
  }

  private isAvailable(definition: ToolDefinition): boolean {
    const capability = this.input.manifest.availableTools.find(
      (candidate) => candidate.id === definition.id,
    );
    return capability !== undefined && capability.availability !== "disabled";
  }

  private failure(
    taskId: string,
    code: Extract<RuntimeToolExecutionResult, { kind: "failed" }>["code"],
    message: string,
    retryable: boolean,
  ): Extract<RuntimeToolExecutionResult, { kind: "failed" }> {
    return {
      kind: "failed",
      code,
      retryable,
      result: {
        taskId,
        status: "FAILED",
        error: { code, message },
        completedAt: new Date(),
      },
    };
  }
}

function isRetryable(metadata: Record<string, unknown>): boolean {
  return metadata.retryable === true;
}
