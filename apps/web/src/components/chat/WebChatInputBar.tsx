import { useHostedHarnessScope } from "../harness/HostedHarnessScope";
import { HostedHarnessPicker } from "../harness/HostedHarnessPicker";
import type { ProviderId } from "@repo/shared-types";
import { ChatInputBar, type ChatInputBarProps } from "@legioncode/client-ui";
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
  const isDelegatedSelected =
    hostedScope.selectionReceipt?.sessionId === props.sessionId &&
    hostedScope.selectionReceipt.selection !== null;
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
          {!isDelegatedSelected
            ? providerControls.renderModelPicker(onWarning)
            : null}
          {!props.isHidden ? (
            <HostedHarnessPicker sessionId={props.sessionId} />
          ) : null}
        </>
      )}
      providerDialog={props.isHidden ? null : providerControls.providerDialog}
      composerPreferences={preferences}
      showContextWindowUsage={preferences.showContextWindowUsage}
    />
  );
}
