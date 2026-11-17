import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  ChatErrorNotice,
  ChatInputBar,
  captureHostedNativeDraft,
  useComposerPreferences,
  type ChatImageAttachmentDraftBinding,
  type ChatSubmitAttachments,
  type HostedNativeDraft,
} from "@legioncode/client-ui";
import { PRODUCT_MODES, RunModeSchema, type BYOKResolution, type ProductMode, type ReasoningEffort, type RunMode } from "@repo/shared-types";
import { DesktopHostedModelPicker } from "./DesktopHostedModelPicker";
import type { useDesktopHostedProviderSettings } from "./useDesktopHostedProviderSettings";

export interface DesktopHostedComposerDraft {
  readonly input: string;
  readonly mode: RunMode;
  readonly productMode: ProductMode;
  readonly reasoningEffort?: ReasoningEffort;
}
export interface DesktopHostedComposerProps {
  readonly draft: DesktopHostedComposerDraft;
  readonly imageDraft: ChatImageAttachmentDraftBinding;
  readonly onDraftChange: (patch: Partial<DesktopHostedComposerDraft>) => void;
  readonly controls: ReturnType<typeof useDesktopHostedProviderSettings>;
  /** Actual account/generation/workspace/session view identity; never a new runtime ID. */
  readonly scopeKey: string;
  readonly active: boolean;
  readonly layout?: "hero" | "docked";
  readonly workspaceBar?: ReactNode;
  readonly isHidden?: boolean;
  readonly configurationLocked?: boolean;
  readonly busy: boolean;
  readonly canStop: boolean;
  readonly onStop?: () => void | Promise<void>;
  readonly onConnectProvider: () => void;
  readonly onManageModels: () => void;
  readonly unavailableReason?: string;
  readonly onSubmit: (draft: HostedNativeDraft, selection: BYOKResolution) => Promise<boolean>;
  readonly onFollowUpSubmit?: (draft: HostedNativeDraft, selection: BYOKResolution, delivery: "queue" | "steer") => Promise<boolean>;
}
const availableModes = RunModeSchema.options;
const availablePermissionModes = Object.values(PRODUCT_MODES);

/** Shared composer presentation; the host owns draft persistence, admission and retry identity. */
export function DesktopHostedComposer({
  draft, imageDraft, onDraftChange, controls, scopeKey, active, layout, workspaceBar, isHidden = false,
  configurationLocked = false, busy, canStop, onStop, onConnectProvider, onManageModels,
  unavailableReason, onSubmit, onFollowUpSubmit,
}: DesktopHostedComposerProps) {
  const preferences = useComposerPreferences();
  const inputDomId = useId();
  const lifetime = useRef(0);
  const submitting = useRef<symbol | null>(null);
  const stopping = useRef<symbol | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [stopPending, setStopPending] = useState(false);
  const [error, setError] = useState<{ message: string; provider: boolean } | null>(null);
  useLayoutEffect(() => {
    lifetime.current += 1;
    submitting.current = null;
    stopping.current = null;
    setPreparing(false);
    setStopPending(false);
    setError(null);
    return () => { lifetime.current += 1; };
  }, [scopeKey, active, isHidden]);
  const hidden = !active || isHidden;
  const locked = configurationLocked || busy || preparing;
  const configurationUnavailable = !availableModes.includes(draft.mode) || !availablePermissionModes.includes(draft.productMode)
    ? "Choose an available mode before sending." : undefined;
  const blocked = hidden ? "This conversation is not currently editable."
    : preparing ? "Confirming the selected hosted provider…"
      : unavailableReason ?? configurationUnavailable ?? controls.unavailableReason;

  const submit = async (attachments?: ChatSubmitAttachments, delivery?: "queue" | "steer"): Promise<boolean> => {
    if (blocked || submitting.current || (!draft.input.trim() && !attachments?.imageAttachments.length) ||
      (delivery ? !busy || !onFollowUpSubmit : busy)) return false;
    // Freeze the human's draft before any provider request can yield to editing or navigation.
    const captured = Object.freeze({ ...draft });
    const capturedImages = Object.freeze((attachments?.imageAttachments ?? []).map((image) => Object.freeze({ ...image })));
    const messageId = crypto.randomUUID();
    const capturedLifetime = lifetime.current;
    const token = Symbol();
    submitting.current = token;
    setPreparing(true);
    setError(null);
    let resolved = false;
    try {
      const selection = Object.freeze({ ...await controls.resolveForSubmission() });
      if (capturedLifetime !== lifetime.current || submitting.current !== token) return false;
      resolved = true;
      const outgoing = captureHostedNativeDraft({
        id: messageId, prompt: captured.input,
        ...(capturedImages.length > 0 ? { imageAttachments: capturedImages } : {}),
        configuration: Object.freeze({ providerId: selection.providerId, modelId: selection.modelId,
          mode: captured.mode, productMode: captured.productMode,
          ...(captured.reasoningEffort ? { reasoningEffort: captured.reasoningEffort } : {}) }),
      });
      return delivery
        ? await onFollowUpSubmit!(outgoing, selection, delivery)
        : await onSubmit(outgoing, selection);
    } catch {
      if (capturedLifetime === lifetime.current) setError({ provider: !resolved,
        message: resolved ? "The message could not be confirmed. Your draft has been kept."
          : "The selected hosted provider could not be confirmed. Your draft has been kept." });
      return false;
    } finally {
      if (submitting.current === token) {
        submitting.current = null;
        if (capturedLifetime === lifetime.current) setPreparing(false);
      }
    }
  };

  return <>
    {!hidden && error ? <ChatErrorNotice message={error.message}
      remediation={error.provider ? "Reconnect or select a hosted provider and model, then try again."
        : "Check the task status before retrying. Your existing draft has been kept."}
      actionLabel="Provider setup" onOpen={error.provider ? onConnectProvider : undefined} /> : null}
    <ChatInputBar
      imageDraft={imageDraft}
      workspaceBar={workspaceBar}
      input={draft.input}
      onChange={(input) => { if (!hidden) { onDraftChange({ input }); setError(null); } }}
      sessionId={`${scopeKey}:${inputDomId}`}
      layout={layout}
      isHidden={hidden}
      viewActive={active}
      mode={draft.mode}
      availableModes={availableModes}
      onModeChange={locked || hidden ? undefined : (mode) => {
        if (availableModes.includes(mode)) onDraftChange({ mode });
      }}
      permissionEnvironment="hosted"
      permissionMode={draft.productMode}
      availablePermissionModes={availablePermissionModes}
      onPermissionModeChange={locked || hidden ? undefined : (productMode) => {
        if (availablePermissionModes.includes(productMode)) onDraftChange({ productMode });
      }}
      composerPreferences={preferences}
      showContextWindowUsage={preferences.showContextWindowUsage}
      submissionUnavailableReason={blocked}
      showSubmissionUnavailableNotice={false}
      renderModelPicker={hidden ? undefined : (onModelSwitchWarning) => <DesktopHostedModelPicker
        controls={{ ...controls, selectModel: async (providerId, modelId) => {
          const capturedLifetime = lifetime.current;
          const changed = controls.provider.selectedProviderId !== providerId || controls.provider.selectedModelId !== modelId;
          await controls.selectModel(providerId, modelId);
          if (changed && capturedLifetime === lifetime.current) onModelSwitchWarning();
        } }}
        disabled={locked}
        onConnectProvider={onConnectProvider}
        onManageModels={onManageModels}
      />}
      isLoading={busy}
      canStop={!hidden && canStop && !stopPending && Boolean(onStop)}
      onStop={onStop ? () => {
        if (hidden || !canStop || stopping.current) return;
        const token = Symbol();
        const capturedLifetime = lifetime.current;
        stopping.current = token;
        setStopPending(true);
        setError(null);
        void Promise.resolve().then(onStop).catch(() => {
          if (capturedLifetime === lifetime.current)
            setError({ message: "Stopping the cloud task could not be confirmed. Check its status before trying again.", provider: false });
        }).finally(() => {
          if (stopping.current === token) {
            stopping.current = null;
            if (capturedLifetime === lifetime.current) setStopPending(false);
          }
        });
      } : undefined}
      onSubmit={(attachments) => submit(attachments)}
      onFollowUpSubmit={onFollowUpSubmit ? (attachments, delivery) => submit(attachments, delivery) : undefined}
    />
  </>;
}
