import { collectLifecycleTurnDiffFiles } from "@legioncode/sdk";
import type { ChatMessageProps, ChatMessageMetadata } from "@legioncode/client-ui";
import { forwardRef, type ReactNode } from "react";
import type {
  DiffContent,
  FileStatus,
  PromptArtifactReviewSource,
} from "@repo/shared-types";
import { buildLifecycleMessageMetadata } from "@legioncode/client-ui";
import type { LifecycleTerminalViewModel } from "@legioncode/client-ui";
import type { TurnDiffPayload } from "../../../services/api/lifecycleClient.js";
import type { EditArtifactIdentity } from "@repo/shared-types";
import type { LifecycleProjection } from "@legioncode/sdk";
import {
  buildLifecycleTerminalViewModel,
} from "@legioncode/client-ui";
import type { CompletedTurnReview } from "@legioncode/client-ui";
import { ChatMessage } from "@legioncode/client-ui";
import { lifecyclePhaseLabel } from "@legioncode/sdk";
import { CanonicalWorkflowSurface } from "@legioncode/client-ui";
import { PendingWorkflowSurface } from "@legioncode/client-ui";
import {
  resolveChangedFilesSummary,
  resolveTerminalChangedFilesSummary,
} from "@legioncode/client-ui";
import type { ChatInterfaceEntry } from "@legioncode/client-ui";
import type { ArtifactOpenHandler } from "@legioncode/client-ui";
import { ChevronDown, Folder } from "lucide-react";

interface ChatInterfaceViewProps {
  workspaceId: string | null;
  threadId: string | null;
  runAttemptId: string | null;
  artifactIdentity?: EditArtifactIdentity | null;
  showHeroComposer: boolean;
  projectName?: string;
  onProjectClick?: () => void;
  showSessionPlaceholder: boolean;
  renderComposer: (layout: "docked" | "hero") => ReactNode;
  debugPanel?: ReactNode;
  resolveHydratedImageSource: ChatMessageProps["resolveHydratedImageSource"];
  loadArtifactContent: ChatMessageProps["loadArtifactContent"];
  chatEntries: ChatInterfaceEntry[];
  hydrationStatus: "readable" | "empty" | "partial" | "recovery-required" | "failed" | "cancelled" | "loading" | "idle";
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
      className="flex h-full flex-col bg-black"
      data-thread-surface={props.threadId ?? undefined}
    >
      {props.lifecycleProjection ? (
        <span data-testid="lifecycle-terminal-settled" className="sr-only">
          {lifecyclePhaseLabel(props.lifecycleProjection.phase)}
        </span>
      ) : null}
      {props.completedTurnReview.error ? (
        <div role="alert" data-testid="completed-turn-review-error">
          {props.completedTurnReview.error}
        </div>
      ) : null}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-3 py-3 sm:px-6 sm:py-4"
      >
        {props.showHeroComposer ? (
          <HeroComposer
            projectName={props.projectName}
            onProjectClick={props.onProjectClick}
          >
            {props.renderComposer("hero")}
          </HeroComposer>
        ) : props.showSessionPlaceholder ? (
          <ChatLoadingIndicator />
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
        <div className="px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-4">
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
  if (
    !props.onUserMessageEdit ||
    entry.message.role !== "user" ||
    !entry.projection?.terminal ||
    (entry.projection.terminal.state !== "interrupted" &&
      entry.projection.terminal.state !== "failed")
  ) {
    return undefined;
  }
  const turnId = entry.projection.turnId;
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
      <CanonicalWorkflowSurface
        projection={entry.projection}
        onArtifactOpen={props.onArtifactOpen}
      />
      {terminal?.state !== "completed" && entry.projection.assistantText.trim() ? (
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
  if (!terminal) return null;

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
        props.includeCurrentTurnReview
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
              onReviewOpen: props.onReviewOpen,
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
              onReviewOpen: props.onReviewOpen,
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
