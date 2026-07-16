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
import type { LifecycleProjection } from "../../../services/lifecycle/LifecycleProjection.js";
import type { CompletedTurnReview } from "./useCompletedTurnReview.js";
import { ChatMessage } from "../ChatMessage";
import { LifecycleWorkflow } from "./LifecycleWorkflow.js";
import { formatDebugPayload } from "./debugPayload.js";
import {
  resolveChangedFilesSummary,
  resolveTerminalChangedFilesSummary,
} from "./changedFiles";
import type { ChatInterfaceEntry } from "./chatEntries";
import type { ComposerLayout } from "./ChatComposerControls";

interface ChatInterfaceViewProps {
  threadId: string | null;
  runAttemptId: string | null;
  showHeroComposer: boolean;
  showSessionPlaceholder: boolean;
  renderComposer: (layout: ComposerLayout) => ReactNode;
  showDebugPanel: boolean;
  debugEvents: ChatDebugEvent[];
  chatEntries: ChatInterfaceEntry[];
  messageMetadataById: Record<string, ChatMessageMetadata>;
  renderActivityTurn: (
    entry: Extract<ChatInterfaceEntry, { kind: "turn" }>["turn"],
  ) => ReactNode;
  onArtifactOpen?: (path: string, content: string) => void;
  onReviewOpen?: () => void;
  snapshots: Record<string, FileStatus[]>;
  artifacts: Record<string, PromptArtifactReviewSource>;
  loadChangedFileDiff: (
    messageId: string,
    file: FileStatus,
  ) => Promise<DiffContent>;
  openPromptArtifactReview: (artifactId: string, messageId?: string) => void;
  terminalViewModel: LifecycleTerminalViewModel | null;
  terminalReviewFiles: FileStatus[];
  terminalTurnDiff: TurnDiffPayload | null;
  loadArtifactChangedFileDiff: (
    artifactId: string,
    file: FileStatus,
  ) => Promise<DiffContent>;
  loadCompletedTurnFileDiff: (file: FileStatus) => Promise<DiffContent>;
  completedTurnReview: CompletedTurnReview;
  showThinking: boolean;
  lifecycleProjection: LifecycleProjection | null;
  workflowDebug: ReactNode;
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
      {props.lifecycleProjection?.terminal ? (
        <span data-testid="lifecycle-terminal-settled" className="sr-only">
          {props.lifecycleProjection.terminal.state}
        </span>
      ) : null}
      {props.completedTurnReview.error ? (
        <div role="alert" data-testid="completed-turn-review-error">
          {props.completedTurnReview.error}
        </div>
      ) : null}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4">
        {props.showHeroComposer ? (
          <HeroComposer>{props.renderComposer("hero")}</HeroComposer>
        ) : props.showSessionPlaceholder ? (
          <ChatLoadingIndicator />
        ) : (
          <div className="mx-auto max-w-4xl space-y-6">
            {props.showDebugPanel ? (
              <ChatDebugPanel events={props.debugEvents} />
            ) : null}
            <Transcript {...props} />
            {props.lifecycleProjection &&
            !props.chatEntries.some(
              (entry) =>
                entry.kind === "turn" &&
                entry.turn.key === props.lifecycleProjection?.turnId,
            ) ? (
              <TurnSurface props={props} turn={null} />
            ) : null}
            {props.showThinking ? <ThinkingIndicator /> : null}
            {props.workflowDebug}
          </div>
        )}
      </div>
      {props.showHeroComposer ? null : (
        <div className="px-6 pb-4">
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
      {props.chatEntries.map((entry) =>
        entry.kind === "turn" ? (
          <TurnSurface
            key={`turn-surface:${entry.turn.key}`}
            props={props}
            turn={entry.turn}
            userMessage={entry.userMessage}
            assistantMessage={entry.assistantMessage}
          />
        ) : (
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
          />
        ),
      )}
    </>
  );
}

function TurnSurface({
  props,
  turn,
  userMessage,
  assistantMessage,
}: {
  props: ChatInterfaceViewProps;
  turn: Extract<ChatInterfaceEntry, { kind: "turn" }>["turn"] | null;
  userMessage?: Extract<ChatInterfaceEntry, { kind: "turn" }>["userMessage"];
  assistantMessage?: Extract<
    ChatInterfaceEntry,
    { kind: "turn" }
  >["assistantMessage"];
}) {
  const turnId = turn?.key ?? props.lifecycleProjection?.turnId;
  if (!turnId) return null;

  if (!props.threadId) return null;

  const surfaceId = `thread-${props.threadId}-turn-${turnId}`;
  const isCurrentTurn = props.lifecycleProjection?.turnId === turnId;
  const hasTool = Boolean(
    turn?.rows.some((row) => row.kind === "tool" || row.kind === "group"),
  );
  const hasApproval = Boolean(
    turn?.rows.some((row) => row.kind === "approval") ||
    (isCurrentTurn && props.lifecycleProjection?.pendingApproval),
  );
  const isActive = Boolean(
    turn?.isActiveTurn ||
    (isCurrentTurn && !props.lifecycleProjection?.terminal),
  );
  const terminal = isCurrentTurn ? props.lifecycleProjection?.terminal : null;
  const hasFinalPart = Boolean(
    assistantMessage ||
    (isCurrentTurn && props.terminalViewModel) ||
    terminal ||
    turn?.rows.some(
      (row) => row.kind === "commentary" && row.phase === "final_answer",
    ),
  );

  return (
    <section
      data-testid={surfaceId}
      data-thread-id={props.threadId}
      data-turn-id={turnId}
      data-run-attempt-id={props.runAttemptId ?? undefined}
      className="space-y-3"
    >
      {userMessage ? (
        <div data-testid={`${surfaceId}-typed-part`} data-kind="user_prompt">
          <ChatMessage
            message={userMessage}
            metadata={props.messageMetadataById[userMessage.id]}
          />
        </div>
      ) : turn?.userPrompt ? (
        <div
          data-testid={`${surfaceId}-typed-part`}
          data-kind="user_prompt"
          className="text-right text-sm text-zinc-300"
        >
          {turn.userPrompt}
        </div>
      ) : null}

      {turn && (hasTool || turn.rows.length > 0) ? (
        <div data-testid={`${surfaceId}-tool-surface`}>
          {props.renderActivityTurn(turn)}
        </div>
      ) : null}
      {hasTool ? (
        <span
          data-testid={`${surfaceId}-tool`}
          className="text-xs text-zinc-500"
        >
          Tool activity
        </span>
      ) : null}
      {isCurrentTurn ? (
        <div data-testid={`${surfaceId}-workflow`}>
          <LifecycleWorkflow projection={props.lifecycleProjection} />
        </div>
      ) : null}
      {hasApproval ? (
        <div
          data-testid={`${surfaceId}-approval`}
          className="text-xs font-medium text-orange-200"
        >
          Approval required
        </div>
      ) : null}
      {isActive ? (
        <div
          data-testid={`${surfaceId}-spinner`}
          role="status"
          className="text-sm text-zinc-500"
        >
          Working
        </div>
      ) : null}
      {terminal ? (
        <div
          data-testid={`${surfaceId}-terminal`}
          data-status={terminal.state}
          className="text-sm text-zinc-400"
        >
          {terminal.state}
          {terminal.errorCode === "SANDBOX_UNAVAILABLE" ? (
            <span
              data-testid={`${surfaceId}-sandbox-error`}
              data-error-code={terminal.errorCode}
            >
              Sandbox unavailable
            </span>
          ) : null}
        </div>
      ) : null}
      {assistantMessage ? (
        <div data-testid={`${surfaceId}-final`}>
          <ChatMessage
            message={assistantMessage}
            metadata={props.messageMetadataById[assistantMessage.id]}
            onArtifactOpen={props.onArtifactOpen}
            onReviewOpen={props.onReviewOpen}
            changedFilesSummary={resolveMessageChangedFilesSummary(
              props,
              assistantMessage.id,
            )}
          />
        </div>
      ) : props.terminalViewModel && isCurrentTurn ? (
        <div data-testid={`${surfaceId}-final`}>
          <TerminalMessage {...props} />
        </div>
      ) : hasFinalPart ? (
        <div
          data-testid={`${surfaceId}-final`}
          className="text-sm text-zinc-400"
        >
          Final output
        </div>
      ) : null}
    </section>
  );
}

function resolveMessageChangedFilesSummary(
  props: ChatInterfaceViewProps,
  messageId: string,
) {
  if (props.completedTurnReview.messageId === messageId) {
    if (props.completedTurnReview.files.length === 0) return undefined;
    return {
      files: props.completedTurnReview.files,
      loadFileDiff: props.completedTurnReview.loadFileDiff,
    };
  }

  return resolveChangedFilesSummary({
    messageId,
    snapshots: props.snapshots,
    artifacts: props.artifacts,
    loadFileDiff: (file) => props.loadChangedFileDiff(messageId, file),
    onPromptArtifactReview: (artifactId) => {
      props.openPromptArtifactReview(artifactId, messageId);
      props.onReviewOpen?.();
    },
  });
}

function TerminalMessage(props: ChatInterfaceViewProps) {
  const terminal = props.terminalViewModel;
  if (!terminal) return null;
  return (
    <ChatMessage
      message={{
        id: terminal.id,
        role: "assistant",
        content: terminal.content,
      }}
      changedFilesSummary={resolveTerminalChangedFilesSummary({
        terminalViewModel: terminal,
        files: props.terminalReviewFiles,
        turnDiff: props.terminalTurnDiff,
        loadArtifactFileDiff: (_artifactId, file) =>
          props.loadCompletedTurnFileDiff(file),
        onPromptArtifactReview: (artifactId) => {
          props.openPromptArtifactReview(artifactId);
          props.onReviewOpen?.();
        },
        onReviewOpen: props.onReviewOpen,
      })}
    />
  );
}

function HeroComposer({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-4xl items-center justify-center py-8">
      <div className="w-full">
        <h1 className="mb-8 text-center text-5xl font-semibold tracking-tight text-zinc-100">
          What should we build?
        </h1>
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

function ThinkingIndicator() {
  return (
    <div className="py-2 text-sm font-medium text-zinc-500">
      <span className="animate-shimmer bg-[linear-gradient(90deg,rgba(113,113,122,0.9)_0%,rgba(228,228,231,0.95)_45%,rgba(113,113,122,0.9)_100%)] bg-[length:220%_100%] bg-clip-text text-transparent">
        Thinking
      </span>
    </div>
  );
}
