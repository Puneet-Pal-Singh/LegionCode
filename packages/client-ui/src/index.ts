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
export { DiffViewer, ChangesList, ChangeItem, DiffLine } from "./review/index.js";
export { ReviewScopeDropdown } from "./review/ReviewScopeDropdown.js";
export { FileTypeIcon } from "./review/FileTypeIcon.js";
export { TreeFilter } from "./review/TreeFilter.js";
export { CODE_TYPOGRAPHY_STYLE } from "./review/codeTypography.js";
export { REVIEW_SOURCE_LABELS, type ReviewScope, type ReviewSourceKind } from "./review/reviewScope.js";
export * from "./review/reviewComments.js";
export { CanonicalWorkflowSurface } from "./conversation/workflow/CanonicalWorkflowSurface.js";
export { PendingWorkflowSurface } from "./conversation/workflow/PendingWorkflowSurface.js";
export { ApprovalDock } from "./conversation/approval/ApprovalDock.js";
export { getDisplayedApprovalDecisions } from "./conversation/approval/approvalDecisions.js";
export { ChatInputBar, type ChatInputBarProps } from "./conversation/ChatInputBar.js";
export { ChatComposerPlusMenu } from "./conversation/ChatComposerPlusMenu.js";
export { ChatImageDropOverlay } from "./conversation/ChatImageDropOverlay.js";
export { PermissionModeControl } from "./conversation/PermissionModeControl.js";
export { ContextUsageRing } from "./conversation/context/ContextUsageRing.js";
export { ContextDetailsPanel, type ContextSessionSnapshot } from "./conversation/context/ContextDetailsPanel.js";
export * from "./conversation/fileMentions.js";

export { buildChatEntries, type ChatInterfaceEntry } from "./conversation/chat-interface/chatEntries.js";
export * from "./conversation/chat-interface/changedFiles.js";
export { buildChatMessageMetadata, buildLifecycleMessageMetadata } from "./conversation/chat-interface/messageMetadata.js";
export { buildLifecycleTerminalViewModel } from "./conversation/chat-interface/LifecycleTerminalViewModel.js";
export type { LifecycleTerminalDisplayState, LifecycleTerminalViewModel } from "./conversation/chat-interface/LifecycleTerminalTypes.js";
