import { ChatErrorNotice, ChatInputBar } from "@legioncode/client-ui";
import {
  PRODUCT_MODES,
  type ThreadId,
  type WorkspaceId,
} from "@repo/platform-protocol";
import { useRef, useState } from "react";
import {
  DesktopModelPicker,
  useDesktopModelPicker,
  type DesktopModelPickerClient,
} from "./DesktopModelPicker";

interface Props {
  client: DesktopModelPickerClient;
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  busy: boolean;
  layout?: "hero" | "docked";
  isHidden?: boolean;
  submissionUnavailableReason?: string;
  onSubmit: (prompt: string) => Promise<boolean>;
  onStop?: () => Promise<void>;
  onOpenSettings: () => void;
  providerRevision: number;
}

/** Draft and delivery state only. The provider route is read from the App Server. */
export function DesktopComposer(props: Props) {
  return (
    <ThreadComposer key={`${props.workspaceId}:${props.threadId}`} {...props} />
  );
}

function ThreadComposer({
  client,
  threadId,
  busy,
  layout,
  isHidden = false,
  submissionUnavailableReason,
  onSubmit,
  onStop,
  onOpenSettings,
  providerRevision,
}: Props) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const submittingRequest = useRef(false);
  const stoppingRequest = useRef(false);

  const modelPicker = useDesktopModelPicker(client, providerRevision);
  const displayError = error ?? modelPicker.error;
  const unavailable =
    submissionUnavailableReason ??
    (submitting ? "Confirming message delivery…" : undefined) ??
    modelPicker.unavailableReason;

  return (
    <div>
      {displayError ? (
        <ChatErrorNotice
          message={displayError}
          remediation="Your draft has been kept."
          actionLabel="Provider setup"
          onOpen={modelPicker.error ? onOpenSettings : undefined}
        />
      ) : null}
      <ChatInputBar
        isHidden={isHidden}
        layout={layout}
        sessionId={threadId}
        input={input}
        onChange={(value) => {
          setInput(value);
          setError(null);
        }}
        mode="plan"
        permissionMode={PRODUCT_MODES.ASK_ALWAYS}
        showContextWindowUsage={false}
        submissionUnavailableReason={unavailable}
        attachmentsAvailable={false}
        renderModelPicker={
          isHidden
            ? undefined
            : () => (
                <DesktopModelPicker
                  controls={modelPicker}
                  onOpenSettings={onOpenSettings}
                />
              )
        }
        isLoading={busy}
        canStop={busy && Boolean(onStop) && !stopping}
        onSubmit={async (attachments) => {
          if (
            isHidden ||
            attachments?.imageAttachments.length ||
            unavailable ||
            busy ||
            submittingRequest.current ||
            !input.trim()
          )
            return false;
          const prompt = input;
          submittingRequest.current = true;
          setSubmitting(true);
          setError(null);
          try {
            const accepted = await onSubmit(prompt);
            if (accepted)
              setInput((current) => (current === prompt ? "" : current));
            return accepted;
          } catch (error) {
            setError(
              error instanceof Error
                ? error.message
                : "The message could not be confirmed. Your draft has been kept.",
            );
            return false;
          } finally {
            submittingRequest.current = false;
            setSubmitting(false);
          }
        }}
        onStop={
          onStop
            ? () => {
                if (stoppingRequest.current) return;
                stoppingRequest.current = true;
                setStopping(true);
                setError(null);
                void onStop()
                  .catch(() =>
                    setError(
                      "Stop could not be confirmed. Waiting for runtime status.",
                    ),
                  )
                  .finally(() => {
                    stoppingRequest.current = false;
                    setStopping(false);
                  });
              }
            : undefined
        }
      />
    </div>
  );
}
