import {
  ChatErrorNotice,
  ConversationContinuationNotice,
  ClientShellLoading,
  ChatInterfaceView,
  useCompletedTurnReview,
  useChatImageAttachmentDraft,
  buildChatEntries,
  convertConversationHistoryMessages,
  useChatAutoScroll,
} from "@legioncode/client-ui";
import {
  LocalTurnConfigurationSchema,
  type LocalTurnConfigurationOptions,
  type AppServerClient,
  buildConversationTurns,
  projectConversationHistoryMessages,
} from "@legioncode/sdk";
import type { Thread, TurnAdmission } from "@repo/platform-protocol";
import { useMemo, useRef, useState } from "react";
import { DesktopApproval } from "./DesktopApproval";
import { DesktopComposer } from "./DesktopComposer";
import { DesktopComposerWorkspaceBar } from "./DesktopComposerWorkspaceBar";
import {
  useDesktopImagePreviews,
} from "./useDesktopImagePreviews";
import { useDesktopConversation } from "./useDesktopConversation";
import type { DesktopSavedReviewTurn } from "./useDesktopSavedReviewSelection";
import { useDesktopThreadComposerDraft, type DesktopComposerDraftHandoff } from "./useDesktopComposerDraft";

export type DesktopExecutionAvailability =
  | { available: true }
  | { available: false; reason: string };

interface Props {
  client: AppServerClient;
  thread: Thread;
  execution: DesktopExecutionAvailability;
  onConnectProvider: () => void;
  onManageModels: () => void;
  providerRevision: number;
  configurationOptions: LocalTurnConfigurationOptions | null;
  workspaceGrantAt: string;
  fileAvailability: { available: true } | { available: false; reason: string };
  projectName?: string;
  onProjectClick?: () => void;
  projectChangeUnavailableReason?: string;
  onReviewTurn?: (turn: DesktopSavedReviewTurn) => void;
  onAdmissionConfirmed?: (admission: TurnAdmission) => void;
  draftHandoff?: DesktopComposerDraftHandoff | null;
  providerReady?: boolean;
}

export function DesktopConversation(props: Props) {
  return (
    <SelectedConversation
      key={`${props.thread.workspaceId}:${props.workspaceGrantAt}:${props.thread.id}`}
      {...props}
    />
  );
}

function SelectedConversation({
  client,
  thread,
  execution,
  onConnectProvider,
  onManageModels,
  providerRevision,
  configurationOptions,
  workspaceGrantAt,
  fileAvailability,
  onReviewTurn,
  onAdmissionConfirmed,
  projectName,
  onProjectClick,
  projectChangeUnavailableReason,
  draftHandoff,
  providerReady = true,
}: Props) {
  // The current local history owner is composed with turn execution. Do not issue
  // unsupported history requests or fabricate an empty saved transcript.
  const conversation = useDesktopConversation(
    client,
    thread,
    execution.available,
    onAdmissionConfirmed,
  );
  const imagePreviews = useDesktopImagePreviews(
    client,
    conversation.messages,
  );
  const admission = conversation.admissions.at(-1);
  const projection = admission
    ? conversation.projections[admission.turn.id]
    : null;
  const pendingApproval =
    !conversation.loading &&
    !conversation.hasNewerPages &&
    projection?.pendingApproval;
  const isApprovalVisible = Boolean(
    execution.available && admission && projection && pendingApproval,
  );
  const unavailableReason =
    projectChangeUnavailableReason ?? (thread.status === "archived"
      ? "Unarchive this task before sending a message."
      : !execution.available
        ? execution.reason
        : conversation.submissionUnavailableReason);

  const admittedConfiguration =
    admission?.userMessage.type === "user_message" &&
    admission.userMessage.content &&
    typeof admission.userMessage.content === "object" &&
    !Array.isArray(admission.userMessage.content)
      ? LocalTurnConfigurationSchema.safeParse(
          admission.userMessage.content.configuration,
        )
      : null;
  const initialConfiguration = admittedConfiguration?.success
    ? admittedConfiguration.data
    : null;
  const draft = useDesktopThreadComposerDraft({
    workspaceId: thread.workspaceId,
    threadId: thread.id,
    initialConfiguration,
    configurationOptions,
    handoff: draftHandoff,
  });
  // The visible input leases capture eligibility; this exact conversation owns
  // attachment URLs and in-flight submission settlement across layout changes.
  const imageDraft = useChatImageAttachmentDraft(false);
  const workspaceControlsReason = projectChangeUnavailableReason ??
    (!providerReady ? "Reconnect Desktop before changing projects."
      : conversation.executionActive || isApprovalVisible
        ? "Stop the current task before changing projects."
        : conversation.deliveryPending || conversation.pendingConfiguration
          ? "Confirm the current message's delivery before changing projects."
          : conversation.loading || !conversation.historyReady || conversation.historyError || conversation.hasNewerPages
            ? "Load the latest saved conversation before changing projects."
            : undefined);
  const projectChangeReason = workspaceControlsReason ??
    (draft.value.input.length > 0 || imageDraft.attachments.length > 0
      ? "Send or clear your draft before changing projects."
      : undefined);
  const projectChoice = useRef({ reason: projectChangeReason, onProjectClick });
  projectChoice.current = { reason: projectChangeReason, onProjectClick };
  const [showProjectChangeNotice, setShowProjectChangeNotice] = useState(false);
  const chooseProject = () => {
    const current = projectChoice.current;
    if (current.reason) {
      setShowProjectChangeNotice(true);
      return;
    }
    setShowProjectChangeNotice(false);
    current.onProjectClick?.();
  };
  const review = useCompletedTurnReview(
    projection ?? null,
    admission?.userMessage.id ?? null,
  );
  const messages = useMemo(() => convertConversationHistoryMessages(projectConversationHistoryMessages(
    conversation.messages.map((message) => ({ ...message, data: { metadata: {
      ...message.data?.metadata,
      imageAttachments: (imagePreviews.referencesByMessage.get(message.id) ?? []).map((source) => ({
        ...source.reference, src: source.token,
      })),
    } } })),
  )), [conversation.messages, imagePreviews.referencesByMessage]);
  const bounds = useMemo(() => {
    const lastUsers = new Map(conversation.messagesWindow?.lastUserByTurn.map((last) => [last.turnId, last.itemId]));
    return Object.fromEntries(conversation.admissions.flatMap((item) => {
      const lastUserMessageId = lastUsers.get(item.turn.id);
      return lastUserMessageId ? [[item.turn.id, { rootUserMessageId: item.userMessage.id, lastUserMessageId }]] : [];
    }));
  }, [conversation.admissions, conversation.messagesWindow]);
  const entries = useMemo(() => buildChatEntries(buildConversationTurns(messages), conversation.projections,
    conversation.activeProjection?.turnId ?? null, bounds),
  [messages, conversation.projections, conversation.activeProjection?.turnId, bounds]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastEntry = entries.at(-1);
  useChatAutoScroll({ activeRun: conversation.executionActive,
    latestMessageKey: lastEntry ? lastEntry.kind === "message" ? lastEntry.message.id : lastEntry.key : null,
    lifecycleSequence: conversation.activeProjection?.lastSequence ?? 0,
    placeholderVisible: conversation.loading,
    scopeKey: `${thread.workspaceId}:${workspaceGrantAt}:${thread.id}`,
    scrollRef, historyNavigation: conversation.historyNavigation });
  const showHeroComposer = !conversation.initialLoading &&
    !conversation.hasNewerPages && !conversation.firstPage && entries.length === 0;
  const unavailableArtifact = async (): Promise<never> => {
    throw new Error("This environment does not provide this saved artifact.");
  };
  return (
    <ChatInterfaceView
      ref={scrollRef}
      workspaceId={thread.workspaceId}
      threadId={thread.id}
      runAttemptId={admission?.runAttemptId ?? null}
      projectName={projectName}
      showProjectChip={false}
      onProjectClick={onProjectClick ? chooseProject : undefined}
      showHeroComposer={showHeroComposer}
      showSessionPlaceholder={conversation.initialLoading}
      placeholderError={
        conversation.historyError
          ? {
              message: conversation.historyError,
              remediation: "Reload saved history to continue.",
              actionLabel: "Reload saved history",
              onOpen: conversation.reload,
            }
          : null
      }
      continuation={
        conversation.continuation === "reconnecting" ||
        conversation.continuation === "stopped"
          ? { status: conversation.continuation, onRetry: conversation.retry }
          : null
      }
      canStopPendingTurn={conversation.canStop}
      onStopPendingTurn={conversation.stop}
      renderComposer={(layout) => (
        <>
          {showProjectChangeNotice && projectChangeReason ? (
            <ChatErrorNotice
              message={projectChangeReason}
              remediation="Your current conversation and draft have been kept."
              actionLabel=""
            />
          ) : null}
          {conversation.loading ? (
            <div className="mb-3 [&>.lc-client-screen]:!h-auto [&>.lc-client-screen]:!w-full [&>.lc-client-screen]:!bg-transparent">
              <ClientShellLoading label="Reading saved conversation…" />
            </div>
          ) : null}
          {showHeroComposer && conversation.historyError ? (
            <ChatErrorNotice
              message={conversation.historyError}
              remediation="Your draft has been kept. Reload saved history before sending."
              actionLabel="Reload saved history"
              onOpen={conversation.reload}
            />
          ) : null}
          {conversation.deliveryError ? (
            <ChatErrorNotice
              message={conversation.deliveryError}
              remediation="Your draft has been kept. Read saved history to confirm delivery before changing it."
              actionLabel="Reload saved history"
              onOpen={conversation.reload}
            />
          ) : null}
          {conversation.continuation === "reconnecting" || conversation.continuation === "stopped" ? (
            <ConversationContinuationNotice
              status={conversation.continuation}
              error={conversation.continuationError}
              onRetry={conversation.retry}
            />
          ) : null}
          {isApprovalVisible && admission && projection && pendingApproval ? (
            <DesktopApproval
              key={`${admission.turn.id}:${admission.runAttemptId}:${pendingApproval.approvalId}`}
              client={client}
              admission={admission}
              projection={projection}
              canStop={conversation.canStop}
              onStop={conversation.stop}
              refresh={conversation.retry}
            />
          ) : null}
          <div hidden={isApprovalVisible}>
            <DesktopComposer
              workspaceBar={layout === "hero" ? (
                <DesktopComposerWorkspaceBar
                  scopeKey={`${thread.workspaceId}:${workspaceGrantAt}:${thread.id}`}
                  projectName={projectName}
                  onChooseProject={onProjectClick ? chooseProject : undefined}
                  projectUnavailableReason={projectChangeReason}
                  disabledReason={workspaceControlsReason}
                />
              ) : undefined}
              layout={layout}
              isHidden={isApprovalVisible}
              client={client}
              workspaceId={thread.workspaceId}
              grantedAt={workspaceGrantAt}
              fileAvailability={fileAvailability}
              threadId={thread.id}
              draft={draft}
              imageDraft={imageDraft}
              providerReady={providerReady}
              busy={execution.available && conversation.executionActive}
              submissionUnavailableReason={unavailableReason}
              onSubmit={conversation.submit}
              onStop={
                !isApprovalVisible && conversation.canStop
                  ? conversation.stop
                  : undefined
              }
              onConnectProvider={onConnectProvider}
              onManageModels={onManageModels}
              providerRevision={providerRevision}
              configurationOptions={configurationOptions}
              initialConfiguration={initialConfiguration}
              pendingConfiguration={conversation.pendingConfiguration}
              pendingSelection={conversation.pendingSelection}
              contextBudget={projection?.contextBudget ?? null}
              usage={projection?.usage ?? null}
            />
          </div>
        </>
      )}
      debugPanel={
        <>
          {conversation.historicalReplayError ? (
            <ChatErrorNotice
              message={conversation.historicalReplayError}
              remediation="An earlier turn's workflow is unavailable; the current turn continues independently."
              actionLabel="Reload saved history"
              onOpen={conversation.reload}
            />
          ) : null}
          {imagePreviews.error ? (
            <ChatErrorNotice
              message={imagePreviews.error}
              remediation="Retry the authenticated saved image read. Saved references remain unchanged."
              actionLabel="Retry images"
              onOpen={imagePreviews.retry}
            />
          ) : null}
          {conversation.firstPage ? (
            <ChatErrorNotice
              message="Earlier saved messages are available."
              remediation="Load the preceding bounded message window. Older Turn pages remain available through the same history reader."
              actionLabel="Earlier messages"
              onOpen={conversation.firstPage}
            />
          ) : null}
          {conversation.hasNewerPages ? (
            <ChatErrorNotice
              message="Showing earlier conversation."
              remediation="Load the next bounded window, or return to the latest saved messages."
              actionLabel={conversation.nextPage ? "Newer messages" : "Latest messages"}
              onOpen={conversation.nextPage ?? conversation.reload}
            />
          ) : null}
          {conversation.hasNewerPages && conversation.nextPage ? (
            <ChatErrorNotice message="Return to the current task." remediation="Load a fresh canonical tail snapshot."
              actionLabel="Latest messages" onOpen={conversation.reload} />
          ) : null}
        </>
      }
      resolveHydratedImageSource={imagePreviews.resolveSource}
      loadArtifactContent={undefined}
      chatEntries={entries}
      hydrationStatus={
        conversation.loading
          ? "loading"
          : conversation.historyError
            ? "failed"
            : entries.length
              ? "readable"
              : "empty"
      }
      hydrationError={conversation.historyError}
      retryHydration={conversation.reload}
      messageMetadataById={{}}
      modeLabel={
        initialConfiguration?.mode === "build"
          ? "Build"
          : initialConfiguration?.mode === "plan"
            ? "Plan"
            : "Mode unavailable"
      }
      resolveModelLabel={(modelId) => modelId}
      snapshots={{}}
      artifacts={{}}
      loadChangedFileDiff={unavailableArtifact}
      selectPromptArtifactReview={() => {}}
      selectCanonicalTurnReview={({ turnId }) => {
        const selected = conversation.admissions.find(
          (item) => item.turn.id === turnId,
        );
        const terminal =
          selected && conversation.projections[selected.turn.id]?.terminal;
        if (selected && terminal && onReviewTurn)
          onReviewTurn({
            workspaceId: selected.run.workspaceId,
            threadId: selected.turn.threadId,
            turnId: selected.turn.id,
            terminalState: terminal.state,
          });
      }}
      terminalViewModel={null}
      terminalReviewFiles={review.files}
      terminalTurnDiff={projection?.turnDiff ?? null}
      loadArtifactChangedFileDiff={unavailableArtifact}
      loadCompletedTurnFileDiff={review.loadFileDiff}
      completedTurnReview={review}
      lifecycleProjection={projection ?? null}
      pendingWorkflow={conversation.awaitingActiveReplay}
    />
  );
}
