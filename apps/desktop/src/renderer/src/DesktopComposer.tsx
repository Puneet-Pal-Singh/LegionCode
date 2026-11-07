import {
  ChatErrorNotice,
  ChatInputBar,
  useComposerPreferences,
} from "@legioncode/client-ui";
import {
  type LocalWorkspaceGrant,
  type ThreadId,
  type WorkspaceId,
} from "@repo/platform-protocol";
import { useEffect, useRef, useState } from "react";
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

interface Props {
  client: DesktopModelPickerClient & DesktopFileMentionsClient;
  workspaceId: WorkspaceId;
  grantedAt: LocalWorkspaceGrant["grantedAt"];
  fileAvailability: { available: true } | { available: false; reason: string };
  threadId: ThreadId;
  busy: boolean;
  layout?: "hero" | "docked";
  isHidden?: boolean;
  submissionUnavailableReason?: string;
  onSubmit: (
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
export function DesktopComposer(props: Props) {
  return (
    <ThreadComposer key={`${props.workspaceId}:${props.threadId}`} {...props} />
  );
}

function ThreadComposer({
  client,
  workspaceId,
  grantedAt,
  fileAvailability,
  threadId,
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
}: Props) {
  const preferences = useComposerPreferences();
  const [draftConfiguration, setDraftConfiguration] = useState(() =>
    LocalTurnConfigurationSchema.parse({
      mode:
        initialConfiguration?.mode ??
        (configurationOptions?.modes.includes("build") ? "build" : "plan"),
    }),
  );
  const configurationTouched = useRef(false);
  const initialMode = initialConfiguration?.mode;
  useEffect(() => {
    if (configurationTouched.current || !initialMode) return;
    setDraftConfiguration((current) =>
      current.mode === initialMode
        ? current
        : { ...current, mode: initialMode },
    );
  }, [initialMode]);
  const configuration = pendingConfiguration ?? draftConfiguration;
  const configurationLocked = busy || pendingConfiguration !== null;
  const [input, setInput] = useState("");
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const slash = mentionQuery?.lastIndexOf("/") ?? -1;
  const mentionDirectory =
    slash >= 0 ? mentionQuery!.slice(0, slash).replace(/^(?:\.\/)+/, "") || "." : ".";
  const mentions = useDesktopFileMentions({
    client,
    workspace: { workspaceId, grantedAt, readiness: "ready" },
    directory: mentionDirectory,
    availability:
      fileAvailability.available && mentionQuery !== null && !isHidden
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
    workspaceId,
  );
  const selectedRoute = pendingSelection ?? modelPicker.selection;
  const selectedModel = selectedRoute
    ? modelPicker.current?.models[selectedRoute.providerId]?.find(
        (model) => model.id === selectedRoute.modelId,
      )
    : undefined;
  const attachmentsAvailable = Boolean(
    configurationOptions?.attachments &&
    selectedModel?.capabilities?.supportsVision === true,
  );
  const attachmentsUnavailableReason = !configurationOptions?.attachments
    ? "Image attachments are unavailable in the current Desktop runtime."
    : "Select a model that supports images to send these attachments.";
  const displayError = error ?? modelPicker.error;
  const unavailable =
    submissionUnavailableReason ??
    (!configurationOptions
      ? "Local execution configuration is unavailable. Restart Desktop to reconnect."
      : !configurationOptions.modes.includes(configuration.mode)
        ? "This execution mode is unavailable in the current environment."
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
        isHidden={isHidden}
        {...mentions}
        onFileMentionQueryChange={setMentionQuery}
        layout={layout}
        sessionId={threadId}
        input={input}
        onChange={(value) => {
          setInput(value);
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
                configurationTouched.current = true;
                setDraftConfiguration((current) => ({ ...current, mode }));
              }
        }
        permissionMode={configuration.productMode}
        onPermissionModeChange={
          configurationLocked || !configurationOptions
            ? undefined
            : (productMode) => {
                if (!configurationOptions.productModes.includes(productMode))
                  return;
                configurationTouched.current = true;
                setDraftConfiguration((current) => ({
                  ...current,
                  productMode,
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
