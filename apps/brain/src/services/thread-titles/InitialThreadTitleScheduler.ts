import { parseNativeProviderBindingForAdmission, type RunRecord, type TurnAdmissionRecord } from "@repo/persistence";
import type { TurnScopeBootstrap } from "@repo/platform-protocol";
import type {
  BYOKModelCapability,
  ProviderModelRuntimeRoute,
} from "@repo/shared-types";
import { resolveProviderRuntimeRoute, type ResolvedProviderRuntimeRoute } from "@repo/provider-core";
import type { Env } from "../../types/ai";
import type { PersistenceService } from "../PersistenceService";
import {
  ThreadTitleGenerationCoordinator,
  type BackgroundTaskOwner,
} from "./ThreadTitleGenerationCoordinator";
import { buildThreadTitleInput } from "./ThreadTitleInput";
import { ThreadTitleService } from "./ThreadTitleService";
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
    const preview = await new ThreadTitleService(env).persistPreview({
      ...scope,
      titleStatus: input.backgroundTaskOwner && nativeProviderCredentials ? "pending" : "failed",
    });
    if (!preview || !input.backgroundTaskOwner || !nativeProviderCredentials) return;
    new ThreadTitleGenerationCoordinator(env).schedule(
      input.backgroundTaskOwner,
      {
        ...scope,
        previewVersion: preview.titleVersion ?? 1,
        nativeProviderCredentials,
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
