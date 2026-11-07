import { ChatErrorNotice } from "@legioncode/client-ui";
import type { AppServerClient } from "@legioncode/sdk";
import type { Thread } from "@repo/platform-protocol";
import { DesktopApproval } from "./DesktopApproval";
import { DesktopComposer } from "./DesktopComposer";
import { DesktopTurnTranscript } from "./DesktopTurnTranscript";
import { useDesktopConversation } from "./useDesktopConversation";

export type DesktopExecutionAvailability =
  | { available: true }
  | { available: false; reason: string };

interface Props {
  client: AppServerClient;
  thread: Thread;
  execution: DesktopExecutionAvailability;
  onOpenSettings: () => void;
  providerRevision: number;
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
  onOpenSettings,
  providerRevision,
}: Props) {
  // The current local history owner is composed with turn execution. Do not issue
  // unsupported history requests or fabricate an empty saved transcript.
  const conversation = useDesktopConversation(
    client,
    thread,
    execution.available,
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

  return (
    <section
      aria-label="Local conversation"
      data-thread-id={thread.id}
      className="flex h-full min-h-0 w-full flex-col"
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto w-full max-w-3xl space-y-5">
          {!execution.available ? (
            <div className="py-8">
              <h2 className="text-lg font-medium text-zinc-100">
                {thread.title}
              </h2>
              <p role="status" className="mt-3 text-sm text-zinc-400">
                {execution.reason} Your draft stays editable below.
              </p>
              <p className="mt-2 text-xs text-zinc-500">
                Saved turn history is unavailable in this environment.
              </p>
            </div>
          ) : null}
          {conversation.loading ? (
            <p role="status">Loading saved conversation…</p>
          ) : null}
          {conversation.error ? (
            <ChatErrorNotice
              message={conversation.error}
              remediation="Read canonical history before continuing. A transport failure does not settle the turn."
              actionLabel="Reload saved history"
              onOpen={conversation.reload}
            />
          ) : null}
          {conversation.interrupting ? (
            <p role="status">Waiting for runtime Stop settlement…</p>
          ) : null}
          {conversation.continuation === "reconnecting" ? (
            <p role="status">Reconnecting to local runtime…</p>
          ) : null}
          {conversation.continuation === "stopped" ? (
            <button type="button" onClick={conversation.retry}>
              Retry live updates
            </button>
          ) : null}
          {conversation.hasNewerPages ? (
            <p role="status">
              Showing earlier turns. Load newer turns before sending.
            </p>
          ) : null}
          {conversation.firstPage || conversation.nextPage ? (
            <nav aria-label="Conversation pages" className="flex gap-3">
              {conversation.firstPage ? (
                <button type="button" onClick={conversation.firstPage}>
                  First turns
                </button>
              ) : null}
              {conversation.nextPage ? (
                <button type="button" onClick={conversation.nextPage}>
                  Next turns
                </button>
              ) : null}
            </nav>
          ) : null}
          {execution.available &&
          !conversation.loading &&
          !conversation.error &&
          conversation.admissions.length === 0 ? (
            <h2 className="py-8 text-lg font-medium text-zinc-100">
              {thread.title}
            </h2>
          ) : null}
          {conversation.admissions.map((item) => (
            <DesktopTurnTranscript
              key={item.turn.id}
              {...item}
              projection={conversation.projections[item.turn.id] ?? null}
            />
          ))}
        </div>
      </div>
      <div className="shrink-0 px-4 pb-5">
        <div className="mx-auto w-full max-w-3xl">
          {execution.available && admission && projection && pendingApproval ? (
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
              isHidden={isApprovalVisible}
              client={client}
              workspaceId={thread.workspaceId}
              threadId={thread.id}
              busy={
                execution.available && conversation.busy && !unavailableReason
              }
              submissionUnavailableReason={unavailableReason}
              onSubmit={conversation.submit}
              onStop={
                !isApprovalVisible && conversation.canStop
                  ? conversation.stop
                  : undefined
              }
              onOpenSettings={onOpenSettings}
              providerRevision={providerRevision}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
