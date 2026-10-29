import {
  ChatErrorNotice,
  type ChatErrorNoticeProps,
} from "../ChatErrorNotice.js";
import { collectLifecycleTurnDiffFiles } from "@legioncode/sdk";
import type { ChatMessageProps } from "../ChatMessage.js";
import type { ChatMessageMetadata } from "../chat-message/types.js";
import { forwardRef, type ReactNode } from "react";
import type {
  DiffContent,
  FileStatus,
  PromptArtifactReviewSource,
} from "@repo/shared-types";
import { buildLifecycleMessageMetadata } from "./messageMetadata.js";
import type { LifecycleTerminalViewModel } from "./LifecycleTerminalTypes.js";
import type { TurnDiffPayload } from "@legioncode/sdk";
import type { EditArtifactIdentity } from "@repo/shared-types";
import type { LifecycleProjection } from "@legioncode/sdk";
import { buildLifecycleTerminalViewModel } from "./LifecycleTerminalViewModel.js";
import {
  useCompletedTurnReview,
  type CompletedTurnReview,
} from "./useCompletedTurnReview.js";
import { ChatMessage } from "../ChatMessage.js";
import { lifecyclePhaseLabel } from "@legioncode/sdk";
import { CanonicalWorkflowSurface } from "../workflow/CanonicalWorkflowSurface.js";
import { PendingWorkflowSurface } from "../workflow/PendingWorkflowSurface.js";
import {
  resolveChangedFilesSummary,
  resolveTerminalChangedFilesSummary,
} from "./changedFiles.js";
import type { ChatInterfaceEntry } from "./chatEntries.js";
import type { ArtifactOpenHandler } from "../artifactOpen.js";
import { ChevronDown, Folder } from "lucide-react";
import { workspaceSnapshotNotice } from "./workspace-snapshot-status.js";

export interface ChatInterfaceViewProps {
  workspaceId: string | null;
  threadId: string | null;
  runAttemptId: string | null;
  artifactIdentity?: EditArtifactIdentity | null;
  showHeroComposer: boolean;
  projectName?: string;
  onProjectClick?: () => void;
  showSessionPlaceholder: boolean;
  placeholderError?: ChatErrorNoticeProps | null;
  continuation?: {
    status: "reconnecting" | "stopped";
    onRetry: () => void;
  } | null;
  canStopPendingTurn?: boolean;
  onStopPendingTurn?: () => void;
  renderComposer: (layout: "docked" | "hero") => ReactNode;
  debugPanel?: ReactNode;
  resolveHydratedImageSource: ChatMessageProps["resolveHydratedImageSource"];
  loadArtifactContent: ChatMessageProps["loadArtifactContent"];
  chatEntries: ChatInterfaceEntry[];
  hydrationStatus:
    | "readable"
    | "empty"
    | "partial"
    | "recovery-required"
    | "failed"
    | "cancelled"
    | "loading"
    | "idle";
  hydrationError: string | null;
  retryHydration?: () => void;
  messageMetadataById: Record<string, ChatMessageMetadata>;
  modeLabel: string;
  resolveModelLabel: (modelId: string) => string;
  onArtifactOpen?: ArtifactOpenHandler;
  onReviewOpen?: () => void;
  snapshots: Record<string, FileStatus[]>;
  artifacts: Record<string, PromptArtifactReviewSource>;
  loadChangedFileDiff: (
    messageId: string,
    file: FileStatus,
  ) => Promise<DiffContent>;
  selectPromptArtifactReview: (
    artifactId: string,
    messageId?: string,
    identity?: EditArtifactIdentity,
  ) => void;
  selectCanonicalTurnReview: (source: {
    readonly turnId: string;
    readonly files: FileStatus[];
    readonly loadFileDiff: (file: FileStatus) => Promise<DiffContent>;
    readonly error: string | null;
  }) => void;
  terminalViewModel: LifecycleTerminalViewModel | null;
  terminalReviewFiles: FileStatus[];
  terminalTurnDiff: TurnDiffPayload | null;
  loadArtifactChangedFileDiff: (
    artifactId: string,
    file: FileStatus,
  ) => Promise<DiffContent>;
  loadCompletedTurnFileDiff: (file: FileStatus) => Promise<DiffContent>;
  completedTurnReview: CompletedTurnReview;
  lifecycleProjection: LifecycleProjection | null;
  onUserMessageEdit?: (turnId: string, content: string) => Promise<boolean>;
  onCompact?: () => void;
  pendingWorkflow: boolean;
}

export const ChatInterfaceView = forwardRef<
  HTMLDivElement,
  ChatInterfaceViewProps
>(function ChatInterfaceView(props, scrollRef) {
  return (
    <div
      className="flex h-full min-h-0 flex-col bg-black"
      data-thread-surface={props.threadId ?? undefined}
    >
      {props.lifecycleProjection ? (
        <span data-testid="lifecycle-terminal-settled" className="sr-only">
          {lifecyclePhaseLabel(props.lifecycleProjection.phase)}
        </span>
      ) : null}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-6 sm:py-4"
      >
        {props.showHeroComposer ? (
          <HeroComposer
            projectName={props.projectName}
            onProjectClick={props.onProjectClick}
          >
            {props.renderComposer("hero")}
          </HeroComposer>
        ) : props.showSessionPlaceholder ? (
          <div className="mx-auto max-w-4xl space-y-3">
            {props.placeholderError ? (
              <ChatErrorNotice {...props.placeholderError} />
            ) : null}
            <ChatLoadingIndicator />
            {props.continuation?.status === "stopped" ? (
              <div
                role="status"
                className="flex items-center gap-3 text-sm text-zinc-400"
              >
                <span>Live updates stopped.</span>
                <button
                  type="button"
                  onClick={props.continuation.onRetry}
                  className="text-zinc-200 underline underline-offset-2 hover:text-white"
                >
                  Retry updates
                </button>
                {props.canStopPendingTurn && props.onStopPendingTurn ? (
                  <button
                    type="button"
                    onClick={props.onStopPendingTurn}
                    className="text-zinc-200 underline underline-offset-2 hover:text-white"
                  >
                    Stop
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="mx-auto max-w-4xl space-y-5 sm:space-y-6">
            {props.hydrationStatus === "recovery-required" ||
            props.hydrationStatus === "failed" ||
            props.hydrationStatus === "partial" ? (
              <div
                role="alert"
                data-testid="chat-history-state"
                className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100"
              >
                <span>
                  {props.hydrationStatus === "partial"
                    ? "Some saved messages could not be loaded."
                    : props.hydrationStatus === "recovery-required"
                      ? "Saved history needs recovery before it can be read."
                      : "Saved history could not be loaded."}
                  {props.hydrationError ? ` ${props.hydrationError}` : ""}
                </span>
                {props.retryHydration ? (
                  <button
                    type="button"
                    onClick={props.retryHydration}
                    className="shrink-0 rounded-md border border-amber-200/30 px-3 py-1.5 font-medium hover:bg-amber-500/15"
                  >
                    Retry history
                  </button>
                ) : null}
              </div>
            ) : null}
            {props.debugPanel}
            <Transcript {...props} />
          </div>
        )}
      </div>
      {props.showHeroComposer || props.showSessionPlaceholder ? null : (
        <div className="shrink-0 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-4">
          <div className="mx-auto max-w-4xl">
            {props.renderComposer("docked")}
          </div>
        </div>
      )}
    </div>
  );
});

function Transcript(props: ChatInterfaceViewProps) {
  return (
    <>
      {props.chatEntries.map((entry) => {
        if (entry.kind === "workflow") {
          return (
            <TurnWorkflowEntry key={entry.key} entry={entry} props={props} />
          );
        }
        return (
          <ChatMessage
            resolveHydratedImageSource={props.resolveHydratedImageSource}
            loadArtifactContent={props.loadArtifactContent}
            key={entry.message.id}
            message={entry.message}
            metadata={props.messageMetadataById[entry.message.id]}
            onArtifactOpen={props.onArtifactOpen}
            onReviewOpen={props.onReviewOpen}
            changedFilesSummary={resolveMessageChangedFilesSummary(
              props,
              entry.message.id,
            )}
            hookAudits={entry.projection?.hookAudits}
            onEdit={resolveUserMessageEdit(props, entry)}
            historyStatus={entry.historyStatus}
          />
        );
      })}
      {props.pendingWorkflow ? <PendingWorkflowSurface /> : null}
    </>
  );
}

function resolveUserMessageEdit(
  props: ChatInterfaceViewProps,
  entry: Extract<ChatInterfaceEntry, { kind: "message" }>,
) {
  const hasContinuationTarget = entry.editTargetTurnId !== undefined;
  if (
    !props.onUserMessageEdit ||
    entry.message.role !== "user" ||
    entry.historyStatus === "revised" ||
    (hasContinuationTarget
      ? !entry.editTargetTerminal
      : !entry.projection?.terminal ||
        (entry.projection.terminal.state !== "interrupted" &&
          entry.projection.terminal.state !== "failed"))
  ) {
    return undefined;
  }
  const turnId = entry.editTargetTurnId ?? entry.projection?.turnId;
  if (!turnId) return undefined;
  return (content: string) => props.onUserMessageEdit!(turnId, content);
}

function TurnWorkflowEntry({
  entry,
  props,
}: {
  entry: Extract<ChatInterfaceEntry, { kind: "workflow" }>;
  props: ChatInterfaceViewProps;
}) {
  const turnId = entry.projection.turnId;
  const surfaceId = props.threadId
    ? `thread-${props.threadId}-turn-${turnId}`
    : null;
  const isCurrentTurn = props.lifecycleProjection?.turnId === turnId;
  const terminal = entry.projection.terminal;
  const terminalViewModel = buildLifecycleTerminalViewModel(entry.projection);
  return (
    <section
      data-testid={surfaceId ?? undefined}
      data-thread-id={props.threadId ?? undefined}
      data-workspace-id={props.workspaceId ?? undefined}
      data-turn-id={turnId}
      data-run-attempt-id={
        surfaceId ? (props.runAttemptId ?? undefined) : undefined
      }
      className="space-y-3"
    >
      {entry.historyStatus === "revised" ? (
        <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">
          Earlier workflow · revised
        </span>
      ) : null}
      {workspaceSnapshotNotice(entry.projection) ? (
        <p
          role="alert"
          className="rounded-lg border border-amber-400/30 bg-amber-950/20 px-3 py-2 text-sm text-amber-100/90"
        >
          {workspaceSnapshotNotice(entry.projection)}
        </p>
      ) : null}
      <CanonicalWorkflowSurface
        projection={entry.projection}
        onArtifactOpen={props.onArtifactOpen}
      />
      {entry.workflowHistory?.length ? (
        <details className="rounded-lg border border-zinc-800/70 px-3 py-2">
          <summary className="cursor-pointer text-xs text-zinc-400 hover:text-zinc-200">
            Earlier workflow activity ({entry.workflowHistory.length})
          </summary>
          <div className="mt-3 max-h-80 space-y-5 overflow-y-auto">
            {entry.workflowHistory.map((historicalEntry) => (
              <TurnWorkflowEntry
                key={historicalEntry.key}
                entry={historicalEntry}
                props={props}
              />
            ))}
          </div>
        </details>
      ) : null}
      {terminal?.state !== "completed" &&
      entry.projection.assistantText.trim() ? (
        <ChatMessage
          message={{
            id: `canonical-assistant:${turnId}`,
            role: "assistant",
            content: entry.projection.assistantText,
          }}
          metadata={buildLifecycleMessageMetadata(
            entry.projection,
            entry.assistantMessage
              ? props.messageMetadataById[entry.assistantMessage.id]
              : undefined,
            props.resolveModelLabel,
            props.modeLabel,
          )}
          onArtifactOpen={props.onArtifactOpen}
          onReviewOpen={props.onReviewOpen}
          hookAudits={entry.projection.hookAudits}
          resolveHydratedImageSource={props.resolveHydratedImageSource}
          loadArtifactContent={props.loadArtifactContent}
        />
      ) : null}
      {terminal?.errorCode ? (
        <span
          data-testid={surfaceId ? `${surfaceId}-terminal-error` : undefined}
          data-error-code={terminal.errorCode}
          className="sr-only"
        >
          {terminal.errorCode}
        </span>
      ) : null}
      {terminalViewModel ? (
        <div data-testid={surfaceId ? `${surfaceId}-final` : undefined}>
          <TerminalMessage
            {...props}
            terminalViewModel={terminalViewModel}
            includeCurrentTurnReview={isCurrentTurn}
            projection={entry.projection}
            hookAudits={entry.projection.hookAudits}
            metadata={buildLifecycleMessageMetadata(
              entry.projection,
              entry.assistantMessage
                ? props.messageMetadataById[entry.assistantMessage.id]
                : undefined,
              props.resolveModelLabel,
              props.modeLabel,
            )}
          />
        </div>
      ) : null}
    </section>
  );
}

function resolveMessageChangedFilesSummary(
  props: ChatInterfaceViewProps,
  messageId: string,
) {
  return resolveChangedFilesSummary({
    messageId,
    snapshots: props.snapshots,
    artifacts: props.artifacts,
    loadFileDiff: (file) => props.loadChangedFileDiff(messageId, file),
    onPromptArtifactReview: (artifactId) => {
      props.selectPromptArtifactReview(
        artifactId,
        messageId,
        props.artifactIdentity ?? undefined,
      );
      props.onReviewOpen?.();
    },
  });
}

function TerminalMessage(
  props: ChatInterfaceViewProps & {
    terminalViewModel: LifecycleTerminalViewModel;
    includeCurrentTurnReview: boolean;
    projection: LifecycleProjection;
    hookAudits: LifecycleProjection["hookAudits"];
    metadata?: ChatMessageMetadata;
  },
) {
  const terminal = props.terminalViewModel;
  const completedTurnReview = useCompletedTurnReview(props.projection, null);
  if (!terminal) return null;

  if (terminal.state === "interrupted") return null;

  if (terminal.state !== "completed") {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-sm"
      >
        <span className="mt-0.5 text-zinc-500" aria-hidden="true">
          {terminal.state === "interrupted" ? "■" : "!"}
        </span>
        <p className="leading-5 text-zinc-300">
          {terminal.content ||
            "The run ended before it could return an answer. Retry the request."}
        </p>
      </div>
    );
  }

  const openCanonicalTurnReview = () => {
    if (!completedTurnReview.turnId) return;
    props.selectCanonicalTurnReview({
      turnId: completedTurnReview.turnId,
      files: completedTurnReview.files,
      loadFileDiff: completedTurnReview.loadFileDiff,
      error: completedTurnReview.error,
    });
    props.onReviewOpen?.();
  };

  return (
    <ChatMessage
      resolveHydratedImageSource={props.resolveHydratedImageSource}
      loadArtifactContent={props.loadArtifactContent}
      message={{
        id: terminal.id,
        role: "assistant",
        content: terminal.content,
      }}
      changedFilesSummary={
        props.projection.workspaceSnapshotState === "unavailable"
          ? undefined
          : props.includeCurrentTurnReview
            ? resolveTerminalChangedFilesSummary({
                terminalViewModel: terminal,
                files: props.terminalReviewFiles,
                turnDiff: props.terminalTurnDiff,
                loadArtifactFileDiff: (_artifactId, file) =>
                  props.loadCompletedTurnFileDiff(file),
                onPromptArtifactReview: (artifactId) => {
                  props.selectPromptArtifactReview(
                    artifactId,
                    undefined,
                    props.artifactIdentity ?? undefined,
                  );
                  props.onReviewOpen?.();
                },
                onReviewOpen: openCanonicalTurnReview,
              })
            : resolveTerminalChangedFilesSummary({
                terminalViewModel: terminal,
                files: collectLifecycleTurnDiffFiles(props.projection),
                turnDiff: props.projection.turnDiff,
                loadArtifactFileDiff: (artifactId, file) =>
                  props.loadArtifactChangedFileDiff(artifactId, file),
                onPromptArtifactReview: (artifactId) => {
                  props.selectPromptArtifactReview(
                    artifactId,
                    undefined,
                    props.artifactIdentity ?? undefined,
                  );
                  props.onReviewOpen?.();
                },
                onReviewOpen: openCanonicalTurnReview,
              })
      }
      hookAudits={props.hookAudits}
      metadata={props.metadata}
    />
  );
}

function HeroComposer({
  children,
  projectName,
  onProjectClick,
}: {
  children: ReactNode;
  projectName?: string;
  onProjectClick?: () => void;
}) {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-4xl items-center justify-center py-8">
      <div className="w-full">
        <h1 className="mb-5 text-center text-3xl font-semibold tracking-tight text-zinc-100 sm:text-5xl">
          What should we build{projectName ? " in " : "?"}
          {projectName ? (
            <button
              type="button"
              onClick={onProjectClick}
              className="inline-flex items-center gap-2 text-zinc-400 underline decoration-zinc-700 decoration-dotted underline-offset-8 transition hover:text-zinc-100"
              aria-label={`Change project from ${projectName}`}
            >
              {projectName}?
              <ChevronDown size={22} aria-hidden="true" />
            </button>
          ) : null}
        </h1>
        {projectName ? (
          <div className="mb-4 flex justify-center">
            <button
              type="button"
              onClick={onProjectClick}
              className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-3 py-2 text-sm text-zinc-200 transition hover:bg-zinc-800"
            >
              <Folder size={15} aria-hidden="true" />
              {projectName}
              <ChevronDown size={14} aria-hidden="true" />
            </button>
          </div>
        ) : null}
        {children}
      </div>
    </div>
  );
}

function ChatLoadingIndicator() {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-4xl items-center justify-center py-8">
      <div
        role="status"
        aria-label="Loading conversation"
        className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-800 border-t-zinc-300"
      />
    </div>
  );
}
