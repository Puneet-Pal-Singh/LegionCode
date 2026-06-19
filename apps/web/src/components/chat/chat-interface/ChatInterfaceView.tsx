import { forwardRef, type ReactNode } from "react";
import type { ChatDebugEvent } from "../../../types/chat-debug.js";
import type {
  DiffContent,
  FileStatus,
  PromptArtifactReviewSource,
} from "@repo/shared-types";
import type { ChatMessageMetadata } from "../messageMetadata";
import type { RunTerminalViewModel } from "../../../services/workflow/RunTerminalViewModel.js";
import { ChatMessage } from "../ChatMessage";
import { formatDebugPayload } from "./approvals";
import {
  resolveChangedFilesSummary,
  resolveTerminalChangedFilesSummary,
} from "./changedFiles";
import type { ChatInterfaceEntry } from "./chatEntries";
import type { ComposerLayout } from "./ChatComposerControls";

interface ChatInterfaceViewProps {
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
  terminalViewModel: RunTerminalViewModel | null;
  terminalReviewFiles: FileStatus[];
  loadArtifactChangedFileDiff: (
    artifactId: string,
    file: FileStatus,
  ) => Promise<DiffContent>;
  showThinking: boolean;
  workflowDebug: ReactNode;
}

export const ChatInterfaceView = forwardRef<
  HTMLDivElement,
  ChatInterfaceViewProps
>(function ChatInterfaceView(props, scrollRef) {
  return (
    <div className="flex h-full flex-col bg-black">
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
            <TerminalMessage {...props} />
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
          props.renderActivityTurn(entry.turn)
        ) : (
          <ChatMessage
            key={entry.message.id}
            message={entry.message}
            metadata={props.messageMetadataById[entry.message.id]}
            onArtifactOpen={props.onArtifactOpen}
            onReviewOpen={props.onReviewOpen}
            changedFilesSummary={resolveChangedFilesSummary({
              messageId: entry.message.id,
              snapshots: props.snapshots,
              artifacts: props.artifacts,
              loadFileDiff: (file) =>
                props.loadChangedFileDiff(entry.message.id, file),
              onPromptArtifactReview: (artifactId) => {
                props.openPromptArtifactReview(artifactId, entry.message.id);
                props.onReviewOpen?.();
              },
            })}
          />
        ),
      )}
    </>
  );
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
        loadArtifactFileDiff: props.loadArtifactChangedFileDiff,
        loadFallbackFileDiff: (file) =>
          props.loadChangedFileDiff(terminal.id, file),
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
