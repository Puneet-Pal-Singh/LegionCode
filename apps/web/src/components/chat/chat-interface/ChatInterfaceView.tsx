import { forwardRef, type ReactNode } from "react";
import type { ChatDebugEvent } from "../../../types/chat-debug.js";
import type {
  DiffContent,
  FileStatus,
  PromptArtifactReviewSource,
} from "@repo/shared-types";
import type { ChatMessageMetadata } from "../messageMetadata";
import type { LifecycleTerminalViewModel } from "../../../services/lifecycle/LifecycleTerminalTypes.js";
import type { TurnDiffPayload } from "../../../services/api/lifecycleClient.js";
import type { EditArtifactIdentity } from "@repo/shared-types";
import type { LifecycleProjection } from "../../../services/lifecycle/LifecycleProjection.js";
import {
  buildLifecycleTerminalViewModel,
  collectLifecycleTurnDiffFiles,
} from "../../../services/lifecycle/LifecycleTerminalViewModel.js";
import type { CompletedTurnReview } from "./useCompletedTurnReview.js";
import { ChatMessage } from "../ChatMessage";
import { lifecyclePhaseLabel } from "../../../services/lifecycle/LifecycleProjection.js";
import { CanonicalWorkflowSurface } from "../workflow/CanonicalWorkflowSurface.js";
import { PendingWorkflowSurface } from "../workflow/PendingWorkflowSurface.js";
import { formatDebugPayload } from "./debugPayload.js";
import {
  resolveChangedFilesSummary,
  resolveTerminalChangedFilesSummary,
} from "./changedFiles";
import type { ChatInterfaceEntry } from "./chatEntries";
import type { ComposerLayout } from "./ChatComposerControls";
import type { ArtifactOpenHandler } from "../artifactOpen";
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
  renderComposer: (layout: ComposerLayout) => ReactNode;
  showDebugPanel: boolean;
  debugEvents: ChatDebugEvent[];
  chatEntries: ChatInterfaceEntry[];
  messageMetadataById: Record<string, ChatMessageMetadata>;
  onArtifactOpen?: ArtifactOpenHandler;
  onReviewOpen?: () => void;
  snapshots: Record<string, FileStatus[]>;
  artifacts: Record<string, PromptArtifactReviewSource>;
  loadChangedFileDiff: (
    messageId: string,
    file: FileStatus,
  ) => Promise<DiffContent>;
  openPromptArtifactReview: (
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
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-4 sm:px-6">
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
          <div className="mx-auto max-w-4xl space-y-6">
            {props.showDebugPanel ? (
              <ChatDebugPanel events={props.debugEvents} />
            ) : null}
            <Transcript {...props} />
          </div>
        )}
      </div>
      {props.showHeroComposer || props.showSessionPlaceholder ? null : (
        <div className="px-3 pb-4 sm:px-6">
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
          />
        );
      })}
      {props.pendingWorkflow ? <PendingWorkflowSurface /> : null}
    </>
  );
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
      props.openPromptArtifactReview(
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
                props.openPromptArtifactReview(
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
                props.openPromptArtifactReview(
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
        <h1 className="mb-5 text-center text-5xl font-semibold tracking-tight text-zinc-100">
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

function ChatDebugPanel({ events }: { events: ChatDebugEvent[] }) {
  return (
    <div className="rounded border border-cyan-800/60 bg-cyan-950/20">
      <div className="border-b border-cyan-800/40 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-cyan-200">
        Debug Trace (Client)
      </div>
      <div className="max-h-56 space-y-3 overflow-y-auto p-3">
        {events.length === 0 ? (
          <div className="text-xs text-cyan-300/70">
            Waiting for first request...
          </div>
        ) : (
          events.map((event) => (
            <div
              key={event.id}
              className="rounded border border-cyan-900/60 bg-black/50 p-2"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-cyan-300">
                  {event.phase}
                </span>
                <span className="text-[11px] text-zinc-400">
                  {new Date(event.timestamp).toLocaleTimeString()}
                </span>
              </div>
              <div className="mb-2 text-xs text-cyan-100">{event.summary}</div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-all text-[11px] text-zinc-200">
                {formatDebugPayload(event.payload)}
              </pre>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
