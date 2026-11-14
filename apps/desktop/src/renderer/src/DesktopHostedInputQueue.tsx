import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import {
  ChatErrorNotice, ThreadInputQueuePanel, updateComposerPreferences,
  captureHostedNativeDraft, useComposerPreferences, useThreadInputQueue, type HostedNativeDraft,
} from "@legioncode/client-ui";
import { createChatThreadInputConfiguration, createConversationInputCommands, readCanonicalTurnId, type AppServerClient, type ConversationScope } from "@legioncode/sdk";
import type { HostedSession, ThreadInputConfiguration } from "@repo/platform-protocol";
import type { BYOKResolution } from "@repo/shared-types";
import type { DesktopHostedConversationController } from "./DesktopHostedConversation";
import { useDesktopHostedImagePreviews } from "./useDesktopHostedImagePreviews";

type Delivery = "queue" | "steer";
type CapturedInput = {
  readonly fingerprint: string;
  readonly draft: HostedNativeDraft;
  readonly scope: ConversationScope;
  readonly delivery: Delivery;
  readonly configuration: ThreadInputConfiguration;
  readonly client: AppServerClient;
  readonly onAcceptedDraft: (draft: HostedNativeDraft) => void;
};
type PendingInput = { readonly capture: CapturedInput; readonly state: "sending" | "uncertain" };
function createCommandOwner() {
  const listeners = new Set<() => void>();
  return {
    commands: createConversationInputCommands(), pending: null as PendingInput | null,
    operation: null as Promise<boolean> | null, error: null as string | null, revision: 0,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    notify() { this.revision += 1; for (const listener of listeners) listener(); },
  };
}
/** Volatile UI command custody only; the server remains the input/persistence authority. */
export function createDesktopHostedInputQueueCustody() {
  const owners = new Map<string, ReturnType<typeof createCommandOwner>>();
  return {
    active: true,
    forBinding(key: string) {
      let owner = owners.get(key);
      if (!owner) { owner = createCommandOwner(); owners.set(key, owner); }
      return owner;
    },
  };
}
export type DesktopHostedInputQueueCustody = ReturnType<typeof createDesktopHostedInputQueueCustody>;
/** Hold above the conditional conversation so navigation cannot replace an uncertain input ID. */
export function useDesktopHostedInputQueueCustody(accountKey: string | null): DesktopHostedInputQueueCustody {
  const custody = useMemo(() => {
    const next = createDesktopHostedInputQueueCustody();
    next.active = accountKey !== null;
    return next;
  }, [accountKey]);
  useLayoutEffect(() => {
    custody.active = accountKey !== null;
    return () => { custody.active = false; };
  }, [custody, accountKey]);
  return custody;
}
export interface DesktopHostedInputQueueOptions {
  readonly custody: DesktopHostedInputQueueCustody;
  readonly client: AppServerClient;
  /** Account, generation, workspace and session identity; do not include the active run. */
  readonly bindingKey: string;
  readonly session: HostedSession;
  readonly controller: DesktopHostedConversationController | null;
  readonly active: boolean;
  readonly onAcceptedDraft: (draft: HostedNativeDraft) => void;
  readonly onSessionRefresh: () => void | Promise<unknown>;
}
export interface DesktopHostedInputQueueControls {
  readonly queuePanel: ReactNode;
  readonly pendingDelivery: boolean;
  readonly canFollowUp: boolean;
  readonly onFollowUpSubmit: (draft: HostedNativeDraft, selection: BYOKResolution, delivery: Delivery) => Promise<boolean>;
}

function boundScope(controller: DesktopHostedConversationController | null, session: HostedSession): ConversationScope | null {
  const scope = controller?.scope;
  const context = controller?.workspaceContext;
  if (!scope || !context || scope.sessionId !== session.id || context.sessionId !== session.id ||
    (session.workspaceId !== null && scope.workspaceId !== session.workspaceId) ||
    (session.threadId !== null && scope.threadId !== session.threadId) ||
    (context.workspaceId !== null && scope.workspaceId !== context.workspaceId) ||
    (context.threadId !== null && scope.threadId !== context.threadId)) return null;
  return scope;
}
function admittedRunningScope(controller: DesktopHostedConversationController | null, session: HostedSession): ConversationScope | null {
  const scope = boundScope(controller, session);
  const projection = controller?.activeProjection;
  if (!scope || !controller?.historyReady || controller.loading || controller.isStopping || projection?.turnId !== scope.turnId ||
    projection.lastSequence <= 0 || projection.terminal) return null;
  if (controller.isSubmitting || controller.pendingDraft) {
    const pending = controller.pendingDraft;
    // A long-lived original HTTP response is not an admission receipt. Saved history is.
    if (!pending || !controller.canonicalMessages.some((message) => message.role === "user" &&
      message.id === pending.id && message.content === pending.prompt && readCanonicalTurnId(message) === scope.turnId)) return null;
  }
  return scope;
}

/** Hosted SDK commands and shared queue presentation, without another submission or runtime owner. */
export function useDesktopHostedInputQueue(options: DesktopHostedInputQueueOptions): DesktopHostedInputQueueControls {
  const { custody, client, bindingKey, session, controller, active } = options;
  const preferences = useComposerPreferences();
  const owner = useMemo(() => custody.forBinding(JSON.stringify([bindingKey, session.id,
    session.workspaceId])), [custody, bindingKey, session.id, session.workspaceId]);
  useSyncExternalStore(owner.subscribe, () => owner.revision, () => owner.revision);
  const current = useRef({ owner, options });
  current.current = { owner, options };
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const isCurrent = () => custody.active && mounted.current && current.current.owner === owner;
  const canAct = () => isCurrent() && current.current.options.active && session.archivedAt === null;
  const scope = controller?.scope ?? null;
  const matchingScope = boundScope(controller, session);
  const projection = controller?.activeProjection;
  const running = Boolean(admittedRunningScope(controller, session));
  const workspaceId = matchingScope?.workspaceId ?? session.workspaceId;
  const threadId = matchingScope?.threadId ?? session.threadId;
  const readScope = useMemo(() => workspaceId && threadId && session.archivedAt === null ? {
    key: JSON.stringify([bindingKey, session.id, workspaceId, threadId]),
    workspaceId, threadId,
  } : null, [bindingKey, session.id, workspaceId, threadId, session.archivedAt]);
  const target = useMemo(() => running && matchingScope ? {
    turnId: matchingScope.turnId, runAttemptId: matchingScope.runAttemptId,
  } : null, [running, matchingScope?.turnId, matchingScope?.runAttemptId]);
  const invalidation = JSON.stringify([scope?.turnId, scope?.runAttemptId, projection?.lastSequence,
    session.activeRunId, session.latestRunId]);
  const queue = useThreadInputQueue(readScope, target, invalidation, client);
  const imageReferences = useMemo(() => queue.snapshot?.items.flatMap((item) => item.mediaRefs) ?? [], [queue.snapshot]);
  const imagePreviews = useDesktopHostedImagePreviews(client, session.id, { references: imageReferences });
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const refreshed = useRef<{ owner: object; key: string } | null>(null);
  const refreshSession = () => {
    if (!isCurrent()) return;
    // Metadata recovery is read-only; it never resubmits the queued prompt.
    void Promise.resolve().then(() => {
      if (isCurrent()) return current.current.options.onSessionRefresh();
      return undefined;
    }).catch(() => undefined);
  };
  useEffect(() => {
    const snapshot = queue.snapshot;
    if (!snapshot || snapshot.workspaceId !== workspaceId || snapshot.threadId !== threadId) return;
    const nextRunId = snapshot.activeRunId ?? snapshot.latestStarted?.receipt.runId;
    if (!nextRunId || nextRunId === session.activeRunId || nextRunId === controller?.scope?.runId) return;
    const key = JSON.stringify([nextRunId, snapshot.latestStarted?.receipt.turnId, snapshot.latestStarted?.receipt.runAttemptId]);
    if (refreshed.current?.owner === owner && refreshed.current.key === key) return;
    refreshed.current = { owner, key };
    refreshSession();
  }, [owner, queue.snapshot, workspaceId, threadId, session.activeRunId, controller?.scope?.runId]);

  const deliver = (capture: CapturedInput): Promise<boolean> => {
    if (!canAct()) return Promise.resolve(false);
    if (owner.operation) return owner.operation;
    owner.pending = { capture, state: "sending" };
    owner.error = null;
    owner.notify();
    const operation: Promise<boolean> = Promise.resolve().then(async () => {
      try {
        const receipt = await owner.commands.submitFollowUp(capture.client, {
          fingerprint: capture.fingerprint, scope: capture.scope, delivery: capture.delivery,
          content: { text: capture.draft.prompt, images: (capture.draft.imageAttachments ?? [])
            .map((image) => ({ dataUrl: image.dataUrl, name: image.name, mediaType: image.mediaType })) },
          configuration: capture.configuration,
        });
        const targetMatches = !("targetTurnId" in receipt) || (receipt.targetTurnId === capture.scope.turnId &&
          receipt.targetRunAttemptId === capture.scope.runAttemptId);
        const accepted = capture.delivery === "queue"
          ? receipt.status === "pending" || receipt.status === "started"
          : receipt.status === "accepted" || receipt.status === "applied" || receipt.status === "unconfirmed";
        if (accepted && targetMatches) {
          owner.pending = null;
          owner.error = receipt.status === "unconfirmed"
            ? "Your steering input was received, but its application was not confirmed. Check the queue and task status; do not resend it." : null;
          // A view callback failure must never turn an accepted command into a transport retry.
          try { if (custody.active) capture.onAcceptedDraft(capture.draft); } catch { /* Receipt remains accepted. */ }
          if (isCurrent()) void queueRef.current.refresh();
          if (receipt.status === "started" || receipt.status === "unconfirmed") refreshSession();
          return true;
        }
        owner.pending = null;
        owner.error = !targetMatches ? "The input receipt does not match its original hosted target. Refresh the task before sending again."
          : receipt.status === "conflict" ? receipt.message
            : "The hosted input was not accepted. Your draft has been kept.";
        if (isCurrent()) void queueRef.current.refresh();
        refreshSession();
        return false;
      } catch {
        // SDK retains the original command/clientInputId under this exact fingerprint.
        owner.pending = { capture, state: "uncertain" };
        owner.error = "Delivery could not be confirmed. Your unchanged input is retained for an explicit retry.";
        return false;
      } finally {
        if (owner.operation === operation) owner.operation = null;
        owner.notify();
      }
    });
    owner.operation = operation;
    return operation;
  };

  const onFollowUpSubmit: DesktopHostedInputQueueControls["onFollowUpSubmit"] = async (draft, selection, delivery) => {
    if (!canAct() || owner.pending || !running || !matchingScope) return false;
    const latest = admittedRunningScope(current.current.options.controller, current.current.options.session);
    if (!latest || latest.turnId !== matchingScope.turnId || latest.runAttemptId !== matchingScope.runAttemptId ||
      latest.runId !== matchingScope.runId) return false;
    const capturedDraft = captureHostedNativeDraft(draft);
    if (capturedDraft.configuration.providerId !== selection.providerId || capturedDraft.configuration.modelId !== selection.modelId) return false;
    const configuration = Object.freeze(createChatThreadInputConfiguration(capturedDraft.configuration));
    const capturedScope = Object.freeze({ ...matchingScope });
    return deliver(Object.freeze({ draft: capturedDraft, scope: capturedScope, delivery, configuration, client,
      onAcceptedDraft: current.current.options.onAcceptedDraft,
      fingerprint: JSON.stringify([bindingKey, session.id, capturedScope, delivery, capturedDraft]),
    }));
  };
  const allowed = () => canAct() && !owner.pending;
  const notice = owner.error;
  const pending = owner.pending;
  return {
    pendingDelivery: pending !== null,
    canFollowUp: active && running && pending === null && session.archivedAt === null,
    onFollowUpSubmit,
    queuePanel: active ? <>
      {notice ? <ChatErrorNotice message={notice}
        remediation="The hosted runtime owns input delivery. Retry preserves the original input identity and target; refreshing does not resend it."
        actionLabel={pending?.state === "uncertain" ? "Retry unchanged input" : "Refresh queue"}
        onOpen={pending?.state === "sending" ? undefined : () => {
          if (!canAct()) return;
          if (owner.pending?.state === "uncertain") void deliver(owner.pending.capture);
          else { void queueRef.current.refresh(); refreshSession(); }
        }} /> : null}
      <ThreadInputQueuePanel snapshot={queue.snapshot} error={queue.error ?? imagePreviews.error}
        onRetry={() => { imagePreviews.retry(); return queue.refresh(); }}
        resolveImageSource={imagePreviews.resolveAttachmentSource} resolveImageSourceId={imagePreviews.sourceId}
        active={Boolean(target)} queuingEnabled={preferences.followUpBehavior === "queue"}
        onQueuingChange={(enabled) => { if (canAct()) updateComposerPreferences({ followUpBehavior: enabled ? "queue" : "steer" }); }}
        onUpdate={(...args) => allowed() ? queue.update(...args) : Promise.resolve(null)}
        onRemove={(...args) => allowed() ? queue.remove(...args) : Promise.resolve(null)}
        onSteer={target ? (...args) => allowed() ? queue.steer(...args) : Promise.resolve(null) : undefined}
        onStart={!target && controller?.canSubmit ? async (...args) => {
          if (!allowed()) return null;
          const receipt = await queue.start(...args);
          if (receipt?.status === "started" && isCurrent()) refreshSession();
          return receipt;
        } : undefined} />
    </> : null,
  };
}

/** Keep mounted for the bound session, including when another placement is visible. */
export function DesktopHostedInputQueue(props: DesktopHostedInputQueueOptions & {
  readonly children: (controls: DesktopHostedInputQueueControls) => ReactNode;
}) {
  const controls = useDesktopHostedInputQueue(props);
  return props.children(controls);
}
