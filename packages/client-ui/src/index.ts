export {
  ClientErrorBoundary,
  type ClientErrorReport,
} from "./shell/ClientErrorBoundary.js";
export { EnvironmentStatus } from "./environment/EnvironmentStatus.js";
export type { AppServerEnvironmentSnapshot } from "@repo/platform-protocol";
export { ClientShell } from "./shell/ClientShell.js";
export { ClientShellLoading } from "./shell/ClientShellLoading.js";
export { WorkspaceFrame, type WorkspaceFrameProps } from "./workspace/WorkspaceFrame.js";
export { WorkspaceTopBar, type WorkspaceTopBarProps } from "./workspace/WorkspaceTopBar.js";
export { ThreadSidebar, type ThreadSidebarProps } from "./navigation/ThreadSidebar.js";
export {
  ConnectProviderChooser,
  type ConnectProviderChooserProps,
} from "./provider/ConnectProviderChooser.js";
export {
  ProviderIcon,
  type ProviderIconProps,
} from "./provider/ProviderIcon.js";
export { cn } from "./classnames.js";
export { MessageContent, MarkdownMessageContent } from "./conversation/chat-message/MessageContent.js";
export { MessageActions } from "./conversation/chat-message/MessageActions.js";
export type { ChatMessageMetadata } from "./conversation/chat-message/types.js";
export { stripAssistantChangeCounts } from "./conversation/chat-message/markdownTransforms.js";
export { ChatImageGallery, type ChatImagePreview } from "./conversation/ChatImageGallery.js";
export { ChatImageAttachmentStrip } from "./conversation/ChatImageAttachmentStrip.js";
export { useChatImageAttachmentDraft } from "./conversation/useChatImageAttachmentDraft.js";
export {
  CHAT_IMAGE_MIME_TYPES, isChatImageMimeType, validateNextImageAttachment,
  createChatImageAttachment, toImageParts, toRedactedImageMetadata,
  formatAttachmentSize, type ChatImageMimeType, type ChatImageAttachment,
  type ChatSubmitAttachments,
} from "./conversation/chatImageAttachments.js";
export { ChangedFilesCard } from "./conversation/chat-message/ChangedFilesCard.js";
export type { ChangedFilesSummary } from "./conversation/chat-message/changed-files-types.js";
export { ChatMessage, type ChatMessageProps } from "./conversation/ChatMessage.js";
export type { ArtifactOpenHandler, ArtifactOpenOptions } from "./conversation/artifactOpen.js";
