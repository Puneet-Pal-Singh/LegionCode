import type { RunRecord } from "@repo/persistence";
import type { TurnScopeBootstrap } from "@repo/platform-protocol";
import type {
  BYOKModelCapability,
  ProviderModelRuntimeRoute,
} from "@repo/shared-types";
import { resolveProviderRuntimeRoute } from "@repo/provider-core";
import type { Env } from "../../types/ai";
import type { PersistenceService } from "../PersistenceService";
import {
  ThreadTitleGenerationCoordinator,
  type BackgroundTaskOwner,
} from "./ThreadTitleGenerationCoordinator";
import { buildThreadTitleInput } from "./ThreadTitleInput";
import { ThreadTitleService } from "./ThreadTitleService";

interface InitialThreadTitleInput {
  sessionId: string;
  userId: string;
  identity: TurnScopeBootstrap;
  prompt: string;
  persistedUserMessageId: string;
  persistedRun?: RunRecord;
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
    const preview = await new ThreadTitleService(env).persistPreview({
      ...scope,
      titleStatus: input.backgroundTaskOwner ? "pending" : "failed",
    });
    if (!preview || !input.backgroundTaskOwner) return;
    // Only accept routing metadata for the same provider/model as the persisted first run.
    const trustedRoute = input.providerRuntimeRoute;
    const sameRoute =
      trustedRoute?.providerId === run?.providerId &&
      trustedRoute?.modelId === run?.modelId;
    const route =
      sameRoute && trustedRoute
        ? {
            runtimeModelId: trustedRoute.modelId,
            providerTransport: trustedRoute.transport,
            providerEndpoint: trustedRoute.endpoint,
          }
        : resolveProviderRuntimeRoute(
            run?.providerId ?? undefined,
            run?.modelId ?? undefined,
          );
    new ThreadTitleGenerationCoordinator(env).schedule(
      input.backgroundTaskOwner,
      {
        ...scope,
        previewVersion: preview.titleVersion ?? 1,
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
