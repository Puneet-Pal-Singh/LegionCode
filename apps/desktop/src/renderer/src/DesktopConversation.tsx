import {
  ChatErrorNotice,
  ChatInterfaceView,
  useCompletedTurnReview,
  type ChatInterfaceEntry,
} from "@legioncode/client-ui";
import {
  LocalTurnConfigurationSchema,
  type LocalTurnConfigurationOptions,
  type AppServerClient,
} from "@legioncode/sdk";
import type { Thread } from "@repo/platform-protocol";
import { DesktopApproval } from "./DesktopApproval";
import { DesktopComposer } from "./DesktopComposer";
import {
  desktopImageSource,
  useDesktopImagePreviews,
} from "./useDesktopImagePreviews";
import { useDesktopConversation } from "./useDesktopConversation";
import type { DesktopSavedReviewTurn } from "./useDesktopSavedReviewSelection";

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
}

export function DesktopConversation(props: Props) {
  return (
    <SelectedConversation
      key={`${props.thread.workspaceId}:${props.thread.id}`}
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
  projectName,
  onProjectClick,
}: Props) {
  // The current local history owner is composed with turn execution. Do not issue
  // unsupported history requests or fabricate an empty saved transcript.
  const conversation = useDesktopConversation(
    client,
    thread,
    execution.available,
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
        : conversation.loading
          ? "Loading saved conversation before sending."
          : conversation.error
            ? "Reload saved history before sending another message."
            : conversation.hasNewerPages
              ? "Load newer turns before sending another message."
              : undefined;

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
      showHeroComposer={
        !conversation.loading &&
        !conversation.error &&
        !conversation.hasNewerPages &&
        !conversation.firstPage &&
        entries.length === 0
      }
      showSessionPlaceholder={conversation.loading}
      placeholderError={
        conversation.error
          ? {
              message: conversation.error,
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
              busy={execution.available && conversation.busy}
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
          : conversation.error
            ? "failed"
            : entries.length
              ? "readable"
              : "empty"
      }
      hydrationError={conversation.error}
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
      pendingWorkflow={conversation.busy && !projection}
    />
  );
}
