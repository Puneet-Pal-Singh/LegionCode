import {
  buildLifecycleTerminalViewModel,
  CanonicalWorkflowSurface,
  ChatMessage,
} from "@legioncode/client-ui";
import type { LifecycleProjection } from "@legioncode/sdk";
import type { Run, RunAttemptId, ThreadItem, Turn } from "@repo/platform-protocol";

export interface DesktopTurnTranscriptProps {
  run: Run;
  turn: Turn;
  runAttemptId: RunAttemptId;
  userMessage: ThreadItem;
  projection: LifecycleProjection | null;
}

/** Presentation of canonical admission records and the SDK's replay projection. */
export function DesktopTurnTranscript({
  run, turn, runAttemptId, userMessage, projection: replay,
}: DesktopTurnTranscriptProps) {
  const projection = replay?.turnId === turn.id ? replay : null;
  const terminal = buildLifecycleTerminalViewModel(projection);
  const assistantText = projection?.assistantText ?? "";
  const prompt = userMessage.type === "user_message" ? userMessage.content.text : null;

  return (
    <section
      aria-label="Local turn"
      data-workspace-id={run.workspaceId}
      data-thread-id={turn.threadId}
      data-run-id={run.id}
      data-turn-id={turn.id}
      data-run-attempt-id={runAttemptId}
      className="space-y-4"
    >
      {typeof prompt === "string" ? (
        <ChatMessage message={{ id: userMessage.id, role: "user", content: prompt }} />
      ) : <p role="status">The saved prompt cannot be displayed.</p>}
      {projection ? <CanonicalWorkflowSurface projection={projection} /> : null}
      {assistantText ? (
        <ChatMessage message={{ id: turn.id, role: "assistant", content: assistantText }} />
      ) : null}
      {terminal ? (
        <div role="status" data-terminal-state={terminal.state}>
          {terminal.state === "completed" ? (
            !assistantText && terminal.content ? (
              <ChatMessage message={{ id: terminal.id, role: "assistant", content: terminal.content }} />
            ) : <span className="sr-only">Turn completed</span>
          ) : <p>{terminal.content || (terminal.state === "interrupted" ? "Turn stopped." : "Turn failed.")}</p>}
        </div>
      ) : null}
    </section>
  );
}
