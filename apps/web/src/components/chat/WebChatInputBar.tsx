import { useMemo } from "react";
import { useHostedHarnessScope } from "../harness/HostedHarnessScope";
import { createHostedAppServerClient } from "../../services/api/appServerClient.js";
import type { ProviderId } from "@repo/shared-types";
import {
  ChatInputBar,
  HarnessSelection,
  type ChatInputBarProps,
} from "@legioncode/client-ui";
import { useComposerPreferences } from "../../lib/composer-preferences";
import { useWebComposerProviderControls } from "./useWebComposerProviderControls.js";

type WebChatInputBarProps = Omit<
  ChatInputBarProps,
  | "renderModelPicker"
  | "providerNotice"
  | "providerQuota"
  | "providerDialog"
  | "showContextWindowUsage"
> & {
  runId?: string;
  hasMessages?: boolean;
  onModelSelect?: (providerId: ProviderId, modelId: string) => void;
};

export function WebChatInputBar({
  runId,
  hasMessages,
  onModelSelect,
  ...props
}: WebChatInputBarProps) {
  const preferences = useComposerPreferences();
  const hostedScope = useHostedHarnessScope();
  const harnessSelectionScope =
    hostedScope.sessionId === props.sessionId
      ? hostedScope.selectionScope
      : null;
  const harnessClient = useMemo(
    () => createHostedAppServerClient().harness,
    [],
  );
  const providerControls = useWebComposerProviderControls({
    runId,
    sessionId: props.sessionId,
    hasMessages,
    onModelSelect,
    isComposerActiveRun: Boolean(props.isLoading || props.canStop),
    isComposerAvailable: !props.isHidden,
  });
  return (
    <ChatInputBar
      {...props}
      {...providerControls}
      renderModelPicker={(onWarning) => (
        <>
          {providerControls.renderModelPicker(onWarning)}
          {!props.isHidden &&
          hostedScope.sessionId === props.sessionId &&
          hostedScope.selectionUnavailableReason ? (
            <p role="status" className="text-xs text-zinc-400">
              {hostedScope.selectionUnavailableReason}
            </p>
          ) : null}
          {!props.isHidden && harnessSelectionScope ? (
            <HarnessSelection
              key={JSON.stringify(harnessSelectionScope)}
              client={harnessClient}
              scope={harnessSelectionScope}
            />
          ) : null}
        </>
      )}
      providerDialog={props.isHidden ? null : providerControls.providerDialog}
      composerPreferences={preferences}
      showContextWindowUsage={preferences.showContextWindowUsage}
    />
  );
}
