import {
  createAppServerLifecycleClient,
  RunIdSchema,
  TurnScopeBootstrapSchema,
  type AppServerClient,
  type ConversationScope,
  type PlatformClient,
} from "@legioncode/sdk";
import {
  ChatRequestBodySchema,
  type ChatRequestBody,
  type HostedSession,
  type HostedSessionWorkspaceContext,
} from "@repo/platform-protocol";
import { buildChatAppendMessage, type ChatImageAttachment } from "../chatImageAttachments.js";

/** Public host binding metadata only. Credentials and connection custody stay in the host. */
export interface HostedNativeConversationBinding {
  readonly target: string;
  readonly accountId: string;
  readonly generation: number;
}

export interface HostedNativeConversationOptions {
  readonly client: AppServerClient;
  readonly binding: HostedNativeConversationBinding;
  readonly session: HostedSession;
  /** The host's saved/new-session run ID, as used by the existing hosted Web flow. */
  readonly runId: string;
  readonly enabled: boolean;
}

export interface HostedNativeDraft {
  /** A stable client message identity retained by the host until delivery is confirmed. */
  readonly id: string;
  readonly prompt: string;
  readonly imageAttachments?: readonly ChatImageAttachment[];
  readonly configuration: Pick<ChatRequestBody,
    "providerId" | "modelId" | "mode" | "productMode" | "reasoningEffort">;
}

/** Capture the original browser draft before provider resolution or admission can yield. */
export function captureHostedNativeDraft(draft: HostedNativeDraft): HostedNativeDraft {
  const configuration = ChatRequestBodySchema.pick({
    providerId: true, modelId: true, mode: true, productMode: true, reasoningEffort: true,
  }).parse(draft.configuration);
  const images = (draft.imageAttachments ?? []).map((image) => Object.freeze({
    id: image.id, name: image.name, mediaType: image.mediaType, dataUrl: image.dataUrl,
    previewUrl: image.previewUrl, byteSize: image.byteSize, source: image.source,
  }));
  let prompt = draft.prompt;
  if (images.length > 0 && !prompt.trim()) {
    const message = buildChatAppendMessage("", images);
    prompt = typeof message.content === "string" ? message.content : message.content
      .filter((part) => part.type === "text").map((part) => part.text).join("\n");
  }
  if (!draft.id.trim() || !prompt.trim() || !configuration.providerId || !configuration.modelId ||
    !["build", "plan"].includes(configuration.mode ?? "")) {
    throw new Error("Choose a model and Build or Plan, then enter a prompt.");
  }
  return Object.freeze({
    id: draft.id, prompt, configuration: Object.freeze(configuration),
    ...(images.length > 0 ? { imageAttachments: Object.freeze(images) } : {}),
  });
}

export interface HostedConversationIdentity {
  readonly client: AppServerClient;
  readonly key: string;
  readonly submissionKey: string;
  readonly accountId: string;
  readonly sessionId: string;
  readonly workspaceId: string | null;
  readonly threadId: string | null;
  readonly runId: string;
  readonly enabled: boolean;
  readonly error: string | null;
}

export function hostedConversationIdentity(options: HostedNativeConversationOptions): HostedConversationIdentity {
  const { session, binding } = options;
  const error = session.userId !== binding.accountId
    ? "The saved task does not belong to the connected account."
    : !RunIdSchema.safeParse(options.runId).success
      ? "The saved task needs a valid hosted run identity."
      : session.archivedAt !== null
        ? "Restore this archived task before opening its conversation."
        : null;
  return Object.freeze({
    client: options.client,
    key: JSON.stringify([binding.target, binding.accountId, binding.generation,
      session.id, session.workspaceId, session.threadId, options.runId, options.enabled]),
    submissionKey: JSON.stringify([binding.target, binding.accountId, binding.generation,
      session.id, session.workspaceId, options.runId]),
    accountId: binding.accountId,
    sessionId: session.id,
    workspaceId: session.workspaceId,
    threadId: session.threadId,
    runId: options.runId,
    enabled: options.enabled && error === null,
    error,
  });
}

export function assertHostedWorkspace(identity: HostedConversationIdentity, context: HostedSessionWorkspaceContext): void {
  if (context.sessionId !== identity.sessionId || context.workspaceId !== identity.workspaceId ||
    (identity.threadId !== null && context.threadId !== identity.threadId)) {
    throw new Error("The hosted workspace response belongs to another task.");
  }
}

export function hostedConversationScope(
  identity: HostedConversationIdentity,
  value: unknown,
  context: HostedSessionWorkspaceContext,
): ConversationScope {
  const scope = TurnScopeBootstrapSchema.parse(value);
  if ((identity.workspaceId !== null && scope.workspaceId !== identity.workspaceId) ||
    (context.workspaceId !== null && scope.workspaceId !== context.workspaceId) ||
    (identity.threadId !== null && scope.threadId !== identity.threadId) ||
    (context.threadId !== null && scope.threadId !== context.threadId)) {
    throw new Error("The server-issued turn belongs to another hosted task.");
  }
  return Object.freeze({ ...scope, sessionId: identity.sessionId, runId: identity.runId });
}

/** SDK ordering plus the full restored attempt tuple, before any event is projected. */
export function hostedLifecycleClient(client: AppServerClient, scope?: ConversationScope | null) {
  return createAppServerLifecycleClient({
    replayLifecycleEvents: async (request, options) => {
      const page = await client.replayLifecycleEvents(request, options);
      if (scope && page.events.some((event) => event.turnId !== scope.turnId ||
        event.threadId !== scope.threadId || event.runAttemptId !== scope.runAttemptId)) {
        throw new Error("Lifecycle replay belongs to another hosted attempt.");
      }
      return page;
    },
  });
}

/** Adapt the existing SDK method shapes; this port has no HTTP or admission authority. */
export function hostedSubmissionClient(client: AppServerClient): Pick<PlatformClient, "submitHostedChat"> {
  return {
    submitHostedChat: (request, options) => {
      if (options?.signal?.aborted) return Promise.reject(new Error("Hosted submission was cancelled before dispatch."));
      return client.submitHostedChat(request, (serialized) => {
        if (options?.signal?.aborted) throw new Error("Hosted submission was cancelled before dispatch.");
        return options?.beforeSendHostedChatEnvelope?.(serialized) ?? serialized;
      }, options?.onChatSubmissionResponse);
    },
  };
}

export function hostedNativeRequest(
  draft: HostedNativeDraft,
  scope: ConversationScope,
  context: HostedSessionWorkspaceContext,
): ChatRequestBody {
  const message = buildChatAppendMessage(draft.prompt, [...draft.imageAttachments ?? []]);
  return {
    providerId: draft.configuration.providerId,
    modelId: draft.configuration.modelId,
    mode: draft.configuration.mode,
    productMode: draft.configuration.productMode,
    ...(draft.configuration.reasoningEffort ? { reasoningEffort: draft.configuration.reasoningEffort } : {}),
    clientMessageId: draft.id,
    sessionId: scope.sessionId,
    runId: scope.runId,
    identity: TurnScopeBootstrapSchema.parse(scope),
    messages: [{ id: draft.id, role: message.role, content: message.content }],
    harnessMode: "platform_owned",
    authMode: "api_key",
    orchestratorBackend: "execution-engine-v1",
    ...(context.repository ? {
      repositoryOwner: context.repository.owner,
      repositoryName: context.repository.name,
      repositoryBranch: context.runBranch ?? context.selectedBranch ?? undefined,
      repositoryBaseUrl: context.repository.repoUrl,
    } : {}),
  };
}
