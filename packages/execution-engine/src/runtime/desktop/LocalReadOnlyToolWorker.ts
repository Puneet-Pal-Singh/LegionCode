import type { NativeProviderToolTracker } from "../engine/KernelAgenticProvider.js";
import { JsonRecordSchema, type ThreadId } from "@repo/platform-protocol";
import type {
  WorkerProtocolPort,
  WorkerToolResult,
} from "@repo/runtime-kernel";
import {
  createCloudSandboxRunCapabilityManifest,
  RunCapabilityManifestSchema,
} from "../capabilities/RuntimeCapabilityManifest.js";
import { RuntimeToolGateway } from "../engine/RuntimeToolGateway.js";
import { RuntimeWorkspaceScope } from "../engine/RuntimeWorkspaceScope.js";
import {
  LOCAL_READ_ONLY_TOOL_IDS,
  LocalReadOnlyExecutionService,
} from "./LocalReadOnlyExecutionService.js";

/** Translates the existing registry/gateway result; RuntimeKernel alone appends lifecycle. */
export class LocalReadOnlyToolWorker implements WorkerProtocolPort {
  readonly executionCapability = "read_only" as const;
  private readonly operations = new Map<
    string,
    Set<Promise<WorkerToolResult>>
  >();

  constructor(
    private readonly executor: LocalReadOnlyExecutionService,
    private readonly threadId: ThreadId,
    private readonly toolTracker?: NativeProviderToolTracker,
  ) {}

  executeTool(
    input: Parameters<WorkerProtocolPort["executeTool"]>[0],
  ): Promise<WorkerToolResult> {
    const operation = this.executeReadTool(input);
    let pending = this.operations.get(input.turnId);
    if (!pending) {
      pending = new Set();
      this.operations.set(input.turnId, pending);
    }
    pending.add(operation);
    const remove = () => {
      pending.delete(operation);
      if (pending.size === 0) this.operations.delete(input.turnId);
    };
    void operation.then(remove, remove);
    return operation;
  }

  async awaitQuiescence(input: {
    readonly turnId: Parameters<WorkerProtocolPort["executeTool"]>[0]["turnId"];
    readonly timeoutMs: number;
  }): Promise<boolean> {
    const pending = this.operations.get(input.turnId);
    if (!pending?.size) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.allSettled([...pending]).then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), input.timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async executeReadTool(
    input: Parameters<WorkerProtocolPort["executeTool"]>[0],
  ): Promise<WorkerToolResult> {
    // This allowlist is a backend capability, independent of approval or model input.
    if (
      !LOCAL_READ_ONLY_TOOL_IDS.some((id) => id === input.toolCall.toolName)
    ) {
      return failure("Local read-only execution does not expose this tool");
    }
    const workspace = input.workspace;
    if (
      workspace.runId !== input.runId ||
      workspace.executionLocation !== "desktop_local"
    ) {
      return failure("Local worker requires its canonical desktop workspace");
    }
    // Reuse the pure registry manifest builder; override location/policies, never a cloud executor.
    const base = createCloudSandboxRunCapabilityManifest({
      runId: input.runId,
      workspaceRoot: workspace.filesystemRoot,
      artifactRoot: workspace.filesystemRoot,
      availableToolIds: LOCAL_READ_ONLY_TOOL_IDS,
    });
    const manifest = RunCapabilityManifestSchema.parse({
      ...base,
      executionLocation: "desktop_local",
      backendId: "desktop_local_read_only",
      filesystemPolicy: { ...base.filesystemPolicy, writable: false },
      unavailableCapabilities: base.unavailableCapabilities.filter(
        (capability) => capability.id !== "desktop_local",
      ),
    });
    const gateway = new RuntimeToolGateway({
      executor: this.executor,
      manifest,
      scope: new RuntimeWorkspaceScope({
        runId: input.runId,
        threadId: this.threadId,
        turnId: input.turnId,
        runAttemptId: input.runAttemptId,
        workspaceId: workspace.workspaceId,
        root: workspace.filesystemRoot,
      }),
    });
    this.toolTracker?.recordToolStarted(input.toolCall);
    const result = await gateway.execute({
      taskId: input.toolCall.toolCallId,
      toolName: input.toolCall.toolName,
      toolInput: {
        ...input.toolCall.input,
        description: input.toolCall.toolName,
      },
      signal: input.signal,
    });
    if (result.kind === "cancelled")
      return { kind: "cancelled", reason: "Local read cancelled" };
    if (result.kind === "failed") {
      const message = result.result.error?.message ?? "Local read failed";
      this.toolTracker?.recordToolFailed(input.toolCall, message, true);
      return failure(message);
    }
    this.toolTracker?.recordToolCompleted(input.toolCall, result.result);
    return {
      kind: "completed",
      output: JsonRecordSchema.parse({
        content: result.result.output?.content ?? "",
        metadata: result.result.output?.metadata ?? {},
      }),
    };
  }
}

function failure(message: string): WorkerToolResult {
  return {
    kind: "failed",
    disposition: "terminal",
    failure: {
      code: "policy_denied",
      message,
      details: null,
      retryable: false,
      correlationId: null,
    },
  };
}
