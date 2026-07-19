import {
  HookRuntimeContextSchema,
  type HookRuntimeContext,
} from "@repo/hook-protocol";
import {
  WorkspaceManifestIdSchema,
  workspaceIdFromExternalId,
} from "@repo/platform-protocol";
import type {
  RuntimeHookOrchestrationPort,
  RuntimeHookTriggerInput,
} from "@repo/runtime-kernel";
import { z } from "zod";
import type { Env } from "../../types/ai";
import { CanonicalHookAuditSink } from "./CanonicalHookAuditSink";
import { withHookDefinitionRepository } from "./HookDefinitionPersistenceFactory";
import { HookRegistry } from "./HookRegistry";
import { HookRunner } from "./HookRunner";
import {
  SystemHookClock,
  WebCryptoHookInvocationIdFactory,
  WebCryptoHookPayloadDigester,
} from "./HookRuntimeDefaults";
import type { HookScopeAuthorizer } from "./HookRuntimePorts";
import {
  createProductionTrustedHookExecutor,
  type TrustedDeclarativeHookExecutor,
} from "./TrustedDeclarativeHookExecutor";
import { withWorkspaceRepository } from "../workspaces/WorkspacePersistenceFactory";

const ScopeIdSchema = z.string().uuid();

export interface ProductionHookOrchestratorInput {
  readonly userId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly runAttemptId: string;
  readonly workspaceRoot: string;
  readonly prompt: string;
  readonly selectedMode: "auto_edit" | "plan";
  readonly backendId: string;
}

/**
 * Lazy construction ensures hook configuration failures settle through the
 * already-started canonical runtime lifecycle rather than failing pre-stream.
 */
export class ProductionHookOrchestrator
  implements RuntimeHookOrchestrationPort
{
  private readonly userId: string;
  private readonly workspaceId: string;
  private readonly executor: TrustedDeclarativeHookExecutor;
  private registryPromise: Promise<HookRegistry> | null = null;

  constructor(
    private readonly env: Env,
    private readonly input: ProductionHookOrchestratorInput,
    executor = createProductionTrustedHookExecutor(),
  ) {
    this.userId = ScopeIdSchema.parse(input.userId);
    this.workspaceId = ScopeIdSchema.parse(input.workspaceId);
    this.executor = executor;
  }

  async runSessionStart(input: RuntimeHookTriggerInput): Promise<void> {
    const context = this.buildAuthorizedContext(input);
    const runner = await this.createRunner(input, context);
    await runner.run(
      "SessionStart",
      {
        context,
        source: "run_attach",
        initialWorkspaceManifestRef: null,
        capabilityManifestRef: buildCapabilityManifestRef(
          context.capabilityManifestId,
        ),
      },
      { triggerEventId: input.triggerEventId },
    );
  }

  async runUserPromptSubmit(
    input: RuntimeHookTriggerInput,
  ): Promise<void> {
    const context = this.buildAuthorizedContext(input);
    const runner = await this.createRunner(input, context);
    await runner.run(
      "UserPromptSubmit",
      {
        context,
        prompt: this.input.prompt,
        attachments: [],
        selectedFiles: [],
        selectedMode: this.input.selectedMode,
      },
      { triggerEventId: input.triggerEventId },
    );
  }

  private async createRunner(
    input: RuntimeHookTriggerInput,
    expectedContext: HookRuntimeContext,
  ): Promise<HookRunner> {
    return new HookRunner({
      registry: await this.loadAuthorizedRegistry(),
      executor: this.executor,
      auditSink: new CanonicalHookAuditSink(
        { runId: input.run.id, threadId: input.run.threadId },
        input.auditAppender,
      ),
      digester: new WebCryptoHookPayloadDigester(),
      invocationIds: new WebCryptoHookInvocationIdFactory(),
      clock: new SystemHookClock(),
      scopeAuthorizer: new ExactHookScopeAuthorizer(expectedContext),
    });
  }

  private async loadAuthorizedRegistry(): Promise<HookRegistry> {
    this.registryPromise ??= this.loadAuthorizedRegistryNow().catch(
      (error: unknown) => {
        this.registryPromise = null;
        throw error;
      },
    );
    return await this.registryPromise;
  }

  private async loadAuthorizedRegistryNow(): Promise<HookRegistry> {
    const ownsWorkspace = await withWorkspaceRepository(
      this.env,
      async (repository) =>
        (await repository.listWorkspaces(this.userId)).some(
          (entry) => entry.workspace.id === this.workspaceId,
        ),
    );
    if (!ownsWorkspace) {
      throw new HookRuntimeScopeError();
    }
    const records = await withHookDefinitionRepository(
      this.env,
      async (repository) =>
        await repository.list({
          userId: this.userId,
          workspaceId: this.workspaceId,
        }),
    );
    return new HookRegistry(records.map((record) => record.definition));
  }

  private buildAuthorizedContext(
    input: RuntimeHookTriggerInput,
  ): HookRuntimeContext {
    if (
      input.run.threadId !== input.turn.threadId ||
      input.run.id !== input.turn.runId ||
      input.run.id !== this.input.runId ||
      input.run.threadId !== this.input.threadId ||
      input.turn.id !== this.input.turnId ||
      input.runAttemptId !== this.input.runAttemptId ||
      input.run.workspaceId !== input.workspace.workspaceId ||
      input.run.workspaceId !== workspaceIdFromExternalId(this.workspaceId) ||
      input.workspace.filesystemRoot !== this.input.workspaceRoot
    ) {
      throw new HookRuntimeScopeError();
    }

    return HookRuntimeContextSchema.parse({
      threadId: input.run.threadId,
      runId: input.run.id,
      turnId: input.turn.id,
      workspaceId: input.run.workspaceId,
      workspaceRoot: input.workspace.filesystemRoot,
      executionLocation: input.workspace.executionLocation,
      backendId: this.input.backendId,
      modelId: input.run.modelId,
      providerId: input.run.providerId,
      permissionMode: "ask",
      capabilityManifestId: capabilityManifestIdFromRun(input.run.id),
      transcriptRef: null,
    });
  }
}

class ExactHookScopeAuthorizer implements HookScopeAuthorizer {
  constructor(private readonly expected: HookRuntimeContext) {}

  async assertAuthorized(context: HookRuntimeContext): Promise<void> {
    const parsed = HookRuntimeContextSchema.parse(context);
    if (JSON.stringify(parsed) !== JSON.stringify(this.expected)) {
      throw new HookRuntimeScopeError();
    }
  }
}

export class HookRuntimeScopeError extends Error {
  readonly code = "HOOK_RUNTIME_SCOPE_MISMATCH";

  constructor() {
    super("Hook runtime scope is not authorized.");
    this.name = "HookRuntimeScopeError";
  }
}

function buildCapabilityManifestRef(manifestId: string): string {
  return `runtime-capabilities/${manifestId}`;
}

function capabilityManifestIdFromRun(runId: string) {
  const suffix = runId.replace(/^run_/, "");
  return WorkspaceManifestIdSchema.parse(`wsm_${suffix}`);
}
