import {
  ChatErrorNotice,
  ConversationContinuationNotice,
  ClientShellLoading,
  ChatInterfaceView,
  useCompletedTurnReview,
  useChatImageAttachmentDraft,
  type ChatInterfaceEntry,
} from "@legioncode/client-ui";
import {
  LocalTurnConfigurationSchema,
  type LocalTurnConfigurationOptions,
  type AppServerClient,
} from "@legioncode/sdk";
import type { Thread, TurnAdmission } from "@repo/platform-protocol";
import { DesktopApproval } from "./DesktopApproval";
import { DesktopComposer } from "./DesktopComposer";
import {
  desktopImageSource,
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
    conversation.admissions,
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
    thread.status === "archived"
      ? "Unarchive this task before sending a message."
      : !execution.available
        ? execution.reason
        : conversation.submissionUnavailableReason;

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
  const review = useCompletedTurnReview(
    projection ?? null,
    admission?.userMessage.id ?? null,
  );
  const entries: ChatInterfaceEntry[] = conversation.admissions.flatMap(
    (item) => {
      const replay = conversation.projections[item.turn.id];
      const result: ChatInterfaceEntry[] = [];
      if (
        item.userMessage.type === "user_message" &&
        typeof item.userMessage.content.text === "string"
      ) {
        result.push({
          kind: "message",
          message: {
            id: item.userMessage.id,
            role: "user",
            content: item.userMessage.content.text,
            data: {
              metadata: {
                imageAttachments: (
                  imagePreviews.referencesByTurn.get(item.turn.id) ?? []
                ).map((reference) => ({
                  ...reference,
                  src: desktopImageSource(item.turn.id, reference.attachmentId),
                })),
              },
            },
          },
          ...(replay ? { projection: replay } : {}),
        });
      }
      if (replay?.turnId === item.turn.id) {
        result.push({
          kind: "workflow",
          key: `workflow:${item.turn.id}`,
          turnId: item.turn.id,
          projection: replay,
        });
      }
      return result;
    },
  );
  const showHeroComposer = !conversation.initialLoading &&
    !conversation.hasNewerPages && !conversation.firstPage && entries.length === 0;
  const unavailableArtifact = async (): Promise<never> => {
    throw new Error("This environment does not provide this saved artifact.");
  };
  return (
    <ChatInterfaceView
      workspaceId={thread.workspaceId}
      threadId={thread.id}
      runAttemptId={admission?.runAttemptId ?? null}
      projectName={projectName}
      onProjectClick={onProjectClick}
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
              message="Earlier saved turns are available."
              remediation="Return to the first page of this conversation."
              actionLabel="First turns"
              onOpen={conversation.firstPage}
            />
          ) : null}
          {conversation.hasNewerPages ? (
            <ChatErrorNotice
              message="Showing earlier conversation."
              remediation="Load newer turns to continue."
              actionLabel="Load newer turns"
              onOpen={conversation.nextPage ?? conversation.reload}
            />
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
