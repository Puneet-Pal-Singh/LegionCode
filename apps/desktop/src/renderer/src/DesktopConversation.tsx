import { ChatErrorNotice } from "@legioncode/client-ui";
import type { AppServerClient } from "@legioncode/sdk";
import type { Thread } from "@repo/platform-protocol";
import { useState } from "react";
import { DesktopComposer } from "./DesktopComposer";
import { DesktopReview } from "./DesktopReview";
import { DesktopTurnTranscript } from "./DesktopTurnTranscript";
import { useDesktopConversation } from "./useDesktopConversation";

export interface DesktopConversationProps {
  client: AppServerClient;
  thread: Thread;
  capabilities: readonly string[];
}

export function DesktopConversation(props: DesktopConversationProps) {
  return <SelectedConversation key={`${props.thread.workspaceId}:${props.thread.id}`} {...props} />;
}

function SelectedConversation({ client, thread, capabilities }: DesktopConversationProps) {
  const conversation = useDesktopConversation(client, thread);
  const [reviewTurnId, setReviewTurnId] = useState<string | null>(null);
  const review = conversation.admissions.find((admission) => admission.turn.id === reviewTurnId);
  const executionAvailable = capabilities.includes("turn-execution-v1");
  const reviewAvailable = capabilities.includes("artifact-review-v1");

  return (
    <section aria-label="Local conversation" data-thread-id={thread.id} className="space-y-5">
      {conversation.loading ? <p role="status">Loading saved conversation…</p> : null}
      {conversation.error ? (
        <ChatErrorNotice
          message={conversation.error}
          remediation="Read the saved history or resume lifecycle delivery. Transport failure does not settle the turn."
          actionLabel="Reload saved history"
          onOpen={conversation.reload}
        />
      ) : null}
      {conversation.interrupting ? <p role="status">Waiting for runtime Stop settlement…</p> : null}
      {conversation.continuation === "reconnecting" ? <p role="status">Reconnecting to local runtime…</p> : null}
      {conversation.continuation === "stopped" ? (
        <button type="button" onClick={conversation.retry}>Retry live updates</button>
      ) : null}
      {conversation.hasNewerPages ? <p role="status">Showing an earlier page. Load newer turns before sending another prompt.</p> : null}
      <nav aria-label="Conversation pages" className="flex gap-3">
        {conversation.firstPage ? <button type="button" onClick={conversation.firstPage}>First turns</button> : null}
        {conversation.nextPage ? <button type="button" onClick={conversation.nextPage}>Next turns</button> : null}
      </nav>
      {conversation.admissions.map((admission) => {
        const projection = conversation.projections[admission.turn.id] ?? null;
        return (
          <div key={admission.turn.id} className="space-y-3">
            <DesktopTurnTranscript {...admission} projection={projection} />
            {projection?.terminal ? (
              <button type="button" onClick={() => setReviewTurnId(admission.turn.id)}>Review saved turn</button>
            ) : null}
          </div>
        );
      })}
      {review ? (
        <DesktopReview
          client={client}
          selection={{ workspaceId: review.run.workspaceId, threadId: review.turn.threadId, turnId: review.turn.id }}
          availability={reviewAvailable ? { available: true } : {
            available: false, reason: "This read-only runtime does not capture turn artifacts.",
          }}
        />
      ) : null}
      {executionAvailable && thread.status === "active" ? (
        <DesktopComposer
          workspaceId={thread.workspaceId}
          threadId={thread.id}
          busy={conversation.busy}
          onSubmit={conversation.submit}
          onStop={conversation.canStop ? conversation.stop : undefined}
        />
      ) : <p role="status">{thread.status === "active" ? "Local turn execution is unavailable in this environment." : "Unarchive this thread before sending another prompt."}</p>}
    </section>
  );
}
