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
  const providerControls = useWebComposerProviderControls({
    runId,
    sessionId: props.sessionId,
    hasMessages,
    onModelSelect,
    isComposerActiveRun: Boolean(props.isLoading || props.canStop),
  });
  return (
    <ChatInputBar
      {...props}
      {...providerControls}
      composerPreferences={preferences}
      showContextWindowUsage={preferences.showContextWindowUsage}
    />
  );
}
