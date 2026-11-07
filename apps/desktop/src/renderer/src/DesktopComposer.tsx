import { ChatInputBar } from "@legioncode/client-ui";
import type { AppServerClient } from "@legioncode/sdk";
import {
  PRODUCT_MODES,
  type ThreadId,
  type WorkspaceId,
} from "@repo/platform-protocol";
import { useEffect, useRef, useState } from "react";

interface Props {
  client: Pick<AppServerClient, "getProviderSelection">;
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  busy: boolean;
  isHidden?: boolean;
  submissionUnavailableReason?: string;
  onSubmit: (prompt: string) => Promise<boolean>;
  onStop?: () => Promise<void>;
  onOpenSettings: () => void;
  providerRevision: number;
}

type Selection = Awaited<ReturnType<AppServerClient["getProviderSelection"]>>;

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
  const [route, setRoute] = useState<{
    client: Props["client"];
    selection: Selection;
    error?: string;
  } | null>(null);
  const submittingRequest = useRef(false);
  const stoppingRequest = useRef(false);

  useEffect(() => {
    let active = true;
    setRoute(null);
    void client
      .getProviderSelection()
      .then((selection) => {
        if (active) setRoute({ client, selection });
      })
      .catch(() => {
        if (active)
          setRoute({
            client,
            selection: null,
            error:
              "Provider selection could not be loaded. Open Settings to retry.",
          });
      });
    return () => {
      active = false;
    };
  }, [client, providerRevision]);

  const selection = route?.client === client ? route.selection : null;
  const unavailable =
    submissionUnavailableReason ??
    (submitting ? "Confirming message delivery…" : undefined) ??
    (route?.client !== client
      ? "Loading the selected provider and model…"
      : route.error) ??
    (!selection
      ? "Select a provider and model in Settings before sending."
      : undefined);

  return (
    <div>
      {error ? (
        <p role="alert" className="mb-2 text-sm text-red-300">
          {error}
        </p>
      ) : null}
      <ChatInputBar
        isHidden={isHidden}
        sessionId={threadId}
        input={input}
        onChange={setInput}
        mode="plan"
        permissionMode={PRODUCT_MODES.ASK_ALWAYS}
        showContextWindowUsage={false}
        submissionUnavailableReason={unavailable}
        attachmentsAvailable={false}
        renderModelPicker={() => (
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label="Select provider and model"
            className="max-w-64 truncate rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            title={
              selection
                ? `${selection.providerId} / ${selection.modelId}`
                : "Select provider and model in Settings"
            }
          >
            {selection
              ? `${selection.providerId} / ${selection.modelId}`
              : "Select model"}
          </button>
        )}
        providerNotice={
          unavailable ? undefined : (
            <p className="text-xs text-zinc-500">
              Local read-only turn. Attachments, Queue and Steer are
              unavailable.
            </p>
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
          } catch {
            setError(
              "The message could not be confirmed. Your draft has been kept.",
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
