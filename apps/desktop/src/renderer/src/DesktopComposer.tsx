import { ChatInputBar } from "@legioncode/client-ui";
import { PRODUCT_MODES, type ThreadId, type WorkspaceId } from "@repo/platform-protocol";
import { useRef, useState } from "react";

export interface DesktopComposerProps {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  busy: boolean;
  hidden?: boolean;
  onSubmit: (prompt: string) => Promise<boolean>;
  onStop?: () => Promise<void>;
}

/** Draft and command-delivery state only; runtime activity is supplied by replay. */
export function DesktopComposer(props: DesktopComposerProps) {
  return <ThreadComposer key={`${props.workspaceId}:${props.threadId}`} {...props} />;
}

function ThreadComposer({ threadId, busy, hidden = false, onSubmit, onStop }: DesktopComposerProps) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const submittingRequest = useRef(false);
  const stoppingRequest = useRef(false);

  return (
    <div>
      {error ? <p role="alert">{error}</p> : null}
      <ChatInputBar
        isHidden={hidden}
        sessionId={threadId}
        input={input}
        onChange={setInput}
        mode="plan"
        permissionMode={PRODUCT_MODES.ASK_ALWAYS}
        providerNotice={<p>Read-only local execution. Image attachments, Queue, and Steer are unavailable.</p>}
        showContextWindowUsage={false}
        isLoading={busy || submitting}
        canStop={busy && Boolean(onStop) && !stopping}
        onSubmit={async (attachments) => {
          if (attachments?.imageAttachments.length) {
            setError("Image attachments are unavailable for local read-only turns. Remove them before sending.");
            return false;
          }
          if (busy || submittingRequest.current || !input.trim()) return false;
          const prompt = input;
          submittingRequest.current = true;
          setSubmitting(true);
          setError(null);
          try {
            const accepted = await onSubmit(prompt);
            if (accepted) setInput((current) => current === prompt ? "" : current);
            return accepted;
          } catch {
            setError("The prompt could not be confirmed. Your draft has been kept.");
            return false;
          } finally {
            submittingRequest.current = false;
            setSubmitting(false);
          }
        }}
        onStop={onStop ? () => {
          if (stoppingRequest.current) return;
          stoppingRequest.current = true;
          setStopping(true);
          setError(null);
          void onStop().catch(() => {
            setError("Stop could not be confirmed. Waiting for runtime status.");
          }).finally(() => {
            stoppingRequest.current = false;
            setStopping(false);
          });
        } : undefined}
      />
    </div>
  );
}
