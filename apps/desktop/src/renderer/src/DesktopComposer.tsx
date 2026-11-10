import {
  ChatErrorNotice,
  ChatInputBar,
  useComposerPreferences,
  type ChatImageAttachmentDraftBinding,
} from "@legioncode/client-ui";
import {
  type LocalWorkspaceGrant,
  type ThreadId,
  type WorkspaceId,
} from "@repo/platform-protocol";
import { useEffect, useId, useRef, useState } from "react";
import {
  LocalTurnConfigurationSchema,
  type LocalTurnConfiguration,
  type LocalTurnConfigurationOptions,
  type LocalTurnStartParams,
  type ContextBudgetSnapshot,
  type UsageCostSnapshot,
} from "@legioncode/sdk";
import {
  useDesktopFileMentions,
  type DesktopFileMentionsClient,
} from "./useDesktopFileMentions";
import {
  DesktopModelPicker,
  useDesktopModelPicker,
  type DesktopModelPickerClient,
} from "./DesktopModelPicker";
import {
  type DesktopComposerDraftBinding,
} from "./useDesktopComposerDraft";

export interface DesktopComposerProps {
  client: (DesktopModelPickerClient & DesktopFileMentionsClient) | null;
  workspaceId: WorkspaceId | null;
  grantedAt: LocalWorkspaceGrant["grantedAt"] | null;
  fileAvailability: { available: true } | { available: false; reason: string };
  threadId: ThreadId | null;
  providerReady?: boolean;
  unboundDraft?: DesktopComposerDraftBinding;
  draft?: DesktopComposerDraftBinding;
  imageDraft?: ChatImageAttachmentDraftBinding;
  busy: boolean;
  layout?: "hero" | "docked";
  isHidden?: boolean;
  submissionUnavailableReason?: string;
  onSubmit?: (
    prompt: string,
    configuration: LocalTurnConfiguration,
    expectedSelection: NonNullable<
      Awaited<ReturnType<DesktopModelPickerClient["getProviderSelection"]>>
    >,
    images?: LocalTurnStartParams["images"],
  ) => Promise<boolean>;
  onStop?: () => Promise<void>;
  onConnectProvider: () => void;
  onManageModels: () => void;
  providerRevision: number;
  configurationOptions: LocalTurnConfigurationOptions | null;
  initialConfiguration: LocalTurnConfiguration | null;
  pendingConfiguration: LocalTurnConfiguration | null;
  pendingSelection: NonNullable<
    Awaited<ReturnType<DesktopModelPickerClient["getProviderSelection"]>>
  > | null;
  contextBudget?: ContextBudgetSnapshot | null;
  usage?: UsageCostSnapshot | null;
}

/** Draft and delivery state only. The provider route is read from the App Server. */
export function DesktopComposer(props: DesktopComposerProps) {
  const draft = props.draft ?? props.unboundDraft;
  if (!draft) throw new Error("Desktop composer requires its scoped draft binding.");
  return (
    <ThreadComposer
      key={props.workspaceId && props.threadId ? `${props.workspaceId}:${props.threadId}` : "unbound-composer"}
      {...props}
      draft={draft}
    />
  );
}

function ThreadComposer({
  client,
  workspaceId,
  grantedAt,
  fileAvailability,
  threadId,
  providerReady = true,
  unboundDraft,
  draft,
  imageDraft,
  busy,
  layout,
  isHidden = false,
  submissionUnavailableReason,
  onSubmit,
  onStop,
  onConnectProvider,
  onManageModels,
  providerRevision,
  configurationOptions,
  initialConfiguration,
  pendingConfiguration,
  pendingSelection,
  contextBudget = null,
  usage = null,
}: DesktopComposerProps & { draft: DesktopComposerDraftBinding }) {
  const preferences = useComposerPreferences();
  const scopeReady = Boolean(client && providerReady && workspaceId && grantedAt && threadId);
  const updateDraft = draft.update;
  const initialMode = initialConfiguration?.mode ?? (configurationOptions
    ? configurationOptions.modes.includes("build") ? "build" : "plan"
    : undefined);
  useEffect(() => {
    if (draft !== unboundDraft || draft.value.configurationTouched || !initialMode) return;
    updateDraft((current) => current.configurationTouched || current.configuration.mode === initialMode
      ? current
      : { ...current, configuration: { ...current.configuration, mode: initialMode } });
  }, [initialMode, draft, unboundDraft, updateDraft]);
  const configuration = pendingConfiguration ?? draft.value.configuration;
  const availableProductModes = configurationOptions?.productModesByMode?.[configuration.mode]
    ?? configurationOptions?.productModes ?? [];
  const configurationLocked = busy || pendingConfiguration !== null;
  const input = draft.value.input;
  // Without a Thread this is only a DOM/list key, never an SDK identity.
  const inputDomId = useId();
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const slash = mentionQuery?.lastIndexOf("/") ?? -1;
  const mentionDirectory =
    slash >= 0 ? mentionQuery!.slice(0, slash).replace(/^(?:\.\/)+/, "") || "." : ".";
  const mentions = useDesktopFileMentions({
    client,
    workspace: scopeReady && workspaceId && grantedAt ? { workspaceId, grantedAt, readiness: "ready" } : null,
    directory: mentionDirectory,
    availability:
      scopeReady && fileAvailability.available && mentionQuery !== null && !isHidden
        ? { available: true }
        : {
            available: false,
            reason: fileAvailability.available
              ? "Type @ to add files."
              : fileAvailability.reason,
          },
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const submittingRequest = useRef(false);
  const stoppingRequest = useRef(false);

  const modelPicker = useDesktopModelPicker(
    client,
    providerRevision,
    workspaceId && grantedAt ? { workspaceId, grantedAt } : null,
    providerReady,
  );
  const selectedRoute = pendingSelection ?? modelPicker.selection;
  const selectedModel = selectedRoute
    ? modelPicker.current?.models[selectedRoute.providerId]?.find(
        (model) => model.id === selectedRoute.modelId,
      )
    : undefined;
  const attachmentsAvailable = Boolean(
    scopeReady &&
    configurationOptions?.attachments &&
    selectedModel?.capabilities?.supportsVision === true,
  );
  const attachmentsUnavailableReason = !scopeReady
    ? "Choose or restore a workspace and create a task before adding images."
    : !configurationOptions?.attachments
    ? "Image attachments are unavailable in the current Desktop runtime."
    : "Select a model that supports images to send these attachments.";
  const displayError = error ?? modelPicker.error;
  const unavailable =
    submissionUnavailableReason ??
    (!scopeReady
      ? "Choose or restore a workspace and create a task before sending."
      : !onSubmit ? "Message delivery is unavailable for this task." : undefined) ??
    (!configurationOptions
      ? "Local execution configuration is unavailable. Restart Desktop to reconnect."
      : !configurationOptions.modes.includes(configuration.mode)
        ? "This execution mode is unavailable in the current environment."
        : !availableProductModes.includes(configuration.productMode)
          ? "This permission level is unavailable in the current environment."
          : undefined) ??
    (submitting ? "Confirming message delivery…" : undefined) ??
    (pendingSelection ? undefined : modelPicker.unavailableReason);

  return (
    <div>
      {displayError ? (
        <ChatErrorNotice
          message={displayError}
          remediation="Your draft has been kept."
          actionLabel="Provider setup"
          onOpen={modelPicker.error ? onConnectProvider : undefined}
        />
      ) : null}
      <ChatInputBar
        imageDraft={imageDraft}
        isHidden={isHidden}
        {...mentions}
        onFileMentionQueryChange={setMentionQuery}
        layout={layout}
        sessionId={threadId ?? inputDomId}
        input={input}
        onChange={(value) => {
          updateDraft((current) => ({ ...current, input: value }));
          setError(null);
        }}
        mode={configuration.mode}
        permissionEnvironment="local"
        availableModes={configurationOptions?.modes ?? []}
        onModeChange={
          configurationLocked || !configurationOptions
            ? undefined
            : (mode) => {
                if (!configurationOptions.modes.includes(mode)) return;
                updateDraft((current) => {
                  const allowed = configurationOptions.productModesByMode?.[mode]
                    ?? configurationOptions.productModes;
                  const supervised = LocalTurnConfigurationSchema.parse({ mode }).productMode;
                  return {
                    ...current,
                    configurationTouched: true,
                    configuration: {
                      ...current.configuration, mode,
                      productMode: allowed.includes(current.configuration.productMode)
                        ? current.configuration.productMode
                        : allowed.includes(supervised) ? supervised : current.configuration.productMode,
                    },
                  };
                });
              }
        }
        permissionMode={configuration.productMode}
        availablePermissionModes={availableProductModes}
        onPermissionModeChange={
          configurationLocked || !configurationOptions
            ? undefined
            : (productMode) => {
                if (!availableProductModes.includes(productMode))
                  return;
                updateDraft((current) => ({
                  ...current,
                  configurationTouched: true,
                  configuration: { ...current.configuration, productMode },
                }));
              }
        }
        composerPreferences={preferences}
        contextBudget={contextBudget}
        usage={usage}
        showContextWindowUsage={preferences.showContextWindowUsage}
        submissionUnavailableReason={unavailable}
        attachmentsAvailable={attachmentsAvailable}
        attachmentsUnavailableReason={attachmentsUnavailableReason}
        renderModelPicker={
          isHidden
            ? undefined
            : (onModelSwitchWarning) => (
                <DesktopModelPicker
                  controls={modelPicker}
                  selectionOverride={pendingSelection ?? undefined}
                  disabled={configurationLocked}
                  onModelSwitchWarning={onModelSwitchWarning}
                  onConnectProvider={onConnectProvider}
                  onManageModels={onManageModels}
                />
              )
        }
        isLoading={busy}
        canStop={busy && Boolean(onStop) && !stopping}
        onSubmit={async (attachments) => {
          const images = attachments?.imageAttachments.map(
            ({ dataUrl, name, mediaType }) => ({ dataUrl, name, mediaType }),
          );
          if (
            isHidden ||
            !scopeReady ||
            !onSubmit ||
            (images?.length && !attachmentsAvailable) ||
            unavailable ||
            busy ||
            submittingRequest.current ||
            (!input.trim() && !images?.length)
          )
            return false;
          const prompt = input;
          submittingRequest.current = true;
          setSubmitting(true);
          setError(null);
          try {
            const expectedSelection = pendingSelection ?? modelPicker.selection;
            if (!expectedSelection)
              throw new Error("Select a provider and model before sending.");
            const accepted = await onSubmit(
              prompt,
              configuration,
              expectedSelection,
              images,
            );
            if (accepted)
              updateDraft((current) => current.input === prompt ? { ...current, input: "" } : current);
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
