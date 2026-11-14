import { parseNativeProviderBindingForAdmission, type RunRecord, type TurnAdmissionRecord, type SessionRecord } from "@repo/persistence";
import type { TurnScopeBootstrap } from "@repo/platform-protocol";
import type {
  BYOKModelCapability,
  ProviderModelRuntimeRoute,
} from "@repo/shared-types";
import { resolveProviderRuntimeRoute, type ResolvedProviderRuntimeRoute } from "@repo/provider-core";
import type { Env } from "../../types/ai";
import { PersistenceService } from "../PersistenceService";
import {
  ThreadTitleGenerationCoordinator,
  type BackgroundTaskOwner,
  type NativeTitleExecution,
} from "./ThreadTitleGenerationCoordinator";
import { buildThreadTitleInput } from "./ThreadTitleInput";
import { ThreadTitleService } from "./ThreadTitleService";
import { withTranscriptRepository } from "../sessions/TranscriptPersistenceFactory";
import { withRunRepository } from "../runs/RunPersistenceFactory";
import type { NativeProviderCredentialContext } from "../providers/NativeProviderCredentialResolver";

interface InitialThreadTitleInput {
  sessionId: string;
  userId: string;
  identity: TurnScopeBootstrap;
  prompt: string;
  persistedUserMessageId: string;
  persistedRun?: RunRecord;
  persistedAdmission?: TurnAdmissionRecord;
  providerRuntimeRoute?: ProviderModelRuntimeRoute;
  modelCapabilities?: BYOKModelCapability;
  backgroundTaskOwner?: BackgroundTaskOwner;
  nativeExecution?: NativeTitleExecution;
  existingPreview?: SessionRecord;
}

/** The coding turn must proceed even when auxiliary title metadata is unavailable. */
export async function scheduleInitialThreadTitle(
  env: Env,
  persistence: PersistenceService,
  input: InitialThreadTitleInput,
): Promise<void> {
  try {
    const first = await persistence.findFirstPersistedUserMessage({
      sessionId: input.sessionId,
      userId: input.userId,
    });
    if (!first || first.id !== input.persistedUserMessageId) return;
    const run = input.persistedRun;
    if (first.runId && first.runId !== run?.id) return;
    const scope = {
      sessionId: input.sessionId,
      threadId: input.identity.threadId,
      runId: first.runId ?? run?.id ?? "",
      workspaceId: input.identity.workspaceId,
      userId: input.userId,
      firstMessageId: first.id,
      prompt: buildThreadTitleInput(input.prompt),
    };
    if (!scope.runId) return;
    let nativeProviderCredentials: NativeProviderCredentialContext | undefined;
    let route: ResolvedProviderRuntimeRoute | undefined;
    let sameRoute = false;
    try {
      const admission = input.persistedAdmission;
      if (!admission || admission.state !== "admitted" || admission.workspaceId === null || !run ||
          run.userId !== scope.userId || run.workspaceId !== scope.workspaceId || run.sessionId !== scope.sessionId) {
        throw new Error("The first title run has no matching Native admission");
      }
      const expectedScope = { userId: scope.userId, workspaceId: scope.workspaceId, sessionId: scope.sessionId,
        threadId: scope.threadId, runId: scope.runId, turnId: input.identity.turnId, runAttemptId: input.identity.runAttemptId };
      const binding = parseNativeProviderBindingForAdmission(admission.nativeProviderBinding, expectedScope);
      parseNativeProviderBindingForAdmission(binding, { userId: admission.userId, workspaceId: admission.workspaceId,
        sessionId: admission.sessionId, threadId: admission.threadId, runId: admission.runId,
        turnId: admission.turnId, runAttemptId: admission.runAttemptId });
      if (binding.providerId !== run.providerId || binding.modelId !== run.modelId) {
        throw new Error("The first title selection differs from its Native admission");
      }
      const fixedRoute = resolveProviderRuntimeRoute(binding.providerId, binding.modelId);
      const trustedRoute = input.providerRuntimeRoute;
      sameRoute = trustedRoute?.providerId === binding.providerId && trustedRoute?.modelId === binding.modelId;
      if (fixedRoute && sameRoute && trustedRoute &&
          (trustedRoute.transport !== fixedRoute.providerTransport || trustedRoute.endpoint !== fixedRoute.providerEndpoint)) {
        throw new Error("The first title route conflicts with its canonical provider route");
      }
      route = fixedRoute ?? (sameRoute && trustedRoute ? {
        runtimeModelId: trustedRoute.modelId, providerTransport: trustedRoute.transport, providerEndpoint: trustedRoute.endpoint,
      } : undefined);
      Object.freeze(binding.scope);
      if (binding.kind === "byok") Object.freeze(binding.credential);
      nativeProviderCredentials = Object.freeze({ binding: Object.freeze(binding), scope: binding.scope });
    } catch {
      // Legacy or missing authority may retain a deterministic preview, but it
      // cannot consult a later user preference or credential for title inference.
      console.warn("[thread-title] native_admission_unavailable");
    }
    const existing = input.existingPreview;
    if (existing && (existing.id !== input.sessionId || existing.userId !== input.userId ||
        existing.workspaceId !== input.identity.workspaceId || existing.threadId !== input.identity.threadId || existing.titleSource !== "preview" || existing.archivedAt !== null)) return;
    const canGenerate = input.nativeExecution && input.backgroundTaskOwner && nativeProviderCredentials &&
      input.persistedAdmission?.executionState === "running" && !input.nativeExecution.signal.aborted;
    const titles = new ThreadTitleService(env);
    const preview = existing && (existing.titleVersion ?? 1) > 1
      ? await titles.persist({ ...scope, title: existing.title, source: "preview",
          titleStatus: canGenerate ? "pending" : "failed", expectedTitleVersion: existing.titleVersion })
      : await titles.persistPreview({ ...scope, titleStatus: canGenerate ? "pending" : "failed" });
    if (!preview || !input.backgroundTaskOwner || !nativeProviderCredentials || !input.nativeExecution ||
        input.persistedAdmission?.executionState !== "running" || input.nativeExecution.signal.aborted) return;
    parseNativeProviderBindingForAdmission(nativeProviderCredentials.binding, input.nativeExecution.scope);
    new ThreadTitleGenerationCoordinator(env, {}, input.nativeExecution).schedule(
      input.backgroundTaskOwner,
      {
        ...scope,
        previewVersion: preview.titleVersion ?? 1,
        nativeProviderCredentials,
        nativeExecution: input.nativeExecution,
        signal: input.nativeExecution.signal,
        providerId: run?.providerId ?? undefined,
        modelId: run?.modelId ?? undefined,
        ...route,
        ...(sameRoute && input.modelCapabilities
          ? { modelCapabilities: input.modelCapabilities }
          : {}),
      },
    );
  } catch {
    console.warn("[thread-title] initial_metadata_unavailable");
  }
}

/** Called only by the retained Native owner after durable claim and ACK. */
export async function scheduleClaimedInitialThreadTitle(env: Env, input: {
  admission: Readonly<TurnAdmissionRecord>;
  identity: TurnScopeBootstrap;
  prompt: string;
  providerRuntimeRoute?: ProviderModelRuntimeRoute;
  modelCapabilities?: BYOKModelCapability;
  execution: NativeTitleExecution;
  owner: BackgroundTaskOwner;
}): Promise<void> {
  try {
    input.execution.signal.throwIfAborted();
    const admission = input.admission;
    if (admission.executionState !== "running" || admission.workspaceId === null) return;
    const persistence = new PersistenceService(env);
    const first = await persistence.findFirstPersistedUserMessage({ sessionId: admission.sessionId, userId: admission.userId });
    if (!first || first.runId !== admission.runId) return;
    const [run, preview] = await Promise.all([
      withRunRepository(env, repository => repository.getRun(admission.runId, admission.userId)),
      withTranscriptRepository(env, async repository => (await repository.listSessions(admission.userId)).sessions.find(session => session.id === admission.sessionId)),
    ]);
    input.execution.signal.throwIfAborted();
    if (!run || !preview) return;
    await scheduleInitialThreadTitle(env, persistence, {
      sessionId: admission.sessionId, userId: admission.userId, identity: input.identity,
      prompt: input.prompt, persistedUserMessageId: first.id, persistedRun: run, persistedAdmission: admission,
      existingPreview: preview, providerRuntimeRoute: input.providerRuntimeRoute, modelCapabilities: input.modelCapabilities,
      nativeExecution: input.execution, backgroundTaskOwner: input.owner,
    });
  } catch {
    console.warn("[thread-title] claimed_metadata_unavailable");
  }
}
