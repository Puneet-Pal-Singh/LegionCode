import { useRef, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  ArrowUp,
  Square,
  X,
  FileText,
  Folder,
  FileCode2,
  Info,
  TerminalSquare,
} from "lucide-react";
import {
  AXIS_PROVIDER_ID,
  canShowProviderInPrimaryUi,
  DEFAULT_RUN_MODE,
  type ProviderId,
  type RunMode,
} from "@repo/shared-types";
import { useProviderStore } from "../../hooks/useProviderStore.js";
import { findCredentialByProviderId } from "../../lib/provider-helpers.js";
import { ProviderDialog, ModelPickerPopover } from "../provider/index.js";
import { ChatComposerPlusMenu } from "./ChatComposerPlusMenu.js";
import {
  applyFileMention,
  filterFileMentionCandidates,
  findActiveFileMention,
  getPreferredMentionPath,
} from "./fileMentions";
import {
  createChatImageAttachment,
  formatAttachmentSize,
  validateNextImageAttachment,
  type ChatImageAttachment,
  type ChatSubmitAttachments,
} from "./chatImageAttachments";
import { resolveWebProviderProductPolicy } from "../../lib/provider-product-policy";
import {
  isProviderModelBootstrapLoading,
  isProviderVisibleModelHydrationPending,
} from "../../lib/provider-model-bootstrap-loading.js";
import type { ReviewCommentDraft } from "../git/reviewComments";
import { getReviewCommentDisplayLabel } from "../git/reviewComments";

const IDLE_SWITCH_WARNING =
  "Changing models mid-conversation will degrade performance.";
const ACTIVE_RUN_SWITCH_WARNING =
  "Stop the current run before changing mode or model.";
const WARNING_AUTO_DISMISS_MS = 4000;
const BUILD_PLACEHOLDER =
  "Ask LegionCode anything, @ to add files, / for commands";
const PLAN_PLACEHOLDER =
  "Inspect the codebase and outline a safe plan without executing changes";
const WEB_PROVIDER_POLICY = resolveWebProviderProductPolicy();

interface ChatInputBarProps {
  input: string;
  onChange: (value: string) => void;
  onSubmit: (
    attachments?: ChatSubmitAttachments,
  ) => boolean | void | Promise<boolean | void>;
  reviewComments?: ReviewCommentDraft[];
  onRemoveReviewComment?: (commentId: string) => void;
  reviewCommentError?: string | null;
  onStop?: () => void;
  canStop?: boolean;
  isLoading?: boolean;
  placeholder?: string;
  sessionId: string;
  mode?: RunMode;
  onModeChange?: (mode: RunMode) => void;
  hasMessages?: boolean;
  onModelSelect?: (providerId: ProviderId, modelId: string) => void;
  repoTree?: Array<{ path: string; type: string; sha: string }>;
  isLoadingRepoTree?: boolean;
  layout?: "docked" | "hero";
}

export function ChatInputBar({
  input,
  onChange,
  onSubmit,
  reviewComments = [],
  onRemoveReviewComment,
  reviewCommentError = null,
  onStop,
  canStop = false,
  isLoading = false,
  placeholder,
  sessionId,
  mode = DEFAULT_RUN_MODE,
  onModeChange,
  hasMessages = false,
  onModelSelect,
  repoTree = [],
  isLoadingRepoTree = false,
  layout = "docked",
}: ChatInputBarProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageAttachmentsRef = useRef<ChatImageAttachment[]>([]);
  const [isFocused, setIsFocused] = useState(false);
  const [imageAttachments, setImageAttachments] = useState<
    ChatImageAttachment[]
  >([]);
  const [imageAttachmentError, setImageAttachmentError] = useState<
    string | null
  >(null);
  const [cursorPosition, setCursorPosition] = useState(0);
  const [highlightedFileIndex, setHighlightedFileIndex] = useState(0);
  const [switchWarningMessage, setSwitchWarningMessage] = useState<string | null>(
    null,
  );
  const [switchWarningTick, setSwitchWarningTick] = useState(0);
  const [dismissedMentionKey, setDismissedMentionKey] = useState<string | null>(
    null,
  );
  const [mentionNavigationKey, setMentionNavigationKey] = useState<string | null>(
    null,
  );
  const [showProviderDialog, setShowProviderDialog] = useState(false);
  const [expandedReviewCommentId, setExpandedReviewCommentId] = useState<
    string | null
  >(null);
  const [providerDialogInitialTab, setProviderDialogInitialTab] = useState<
    "connected" | "available" | "preferences" | "session" | undefined
  >(undefined);
  const [providerDialogInitialView, setProviderDialogInitialView] = useState<
    "default" | "manage-models"
  >("default");
  const [providerDialogVariant, setProviderDialogVariant] = useState<
    "full" | "connect-only" | "manage-models-only"
  >("full");
  const {
    catalog,
    credentials,
    status,
    selectedProviderId,
    selectedModelId,
    axisQuota,
    selectedModelView,
    lastResolvedConfig,
    providerModels,
    manageProviderModels,
    providerModelsMetadata,
    providerModelsPage,
    visibleModelIds,
    loadingModelsForProviderId,
    loadingManageModelsForProviderIds,
    refreshingModelsForProviderId,
    loadProviderModels,
    loadManageProviderModels,
    loadMoreProviderModels,
    refreshProviderModels,
    setModelView,
    applySessionSelection,
  } = useProviderStore();
  const hasImageAttachments = imageAttachments.length > 0;
  const hasInput = input.trim().length > 0;
  const hasReviewComments = reviewComments.length > 0;
  const canSubmit = hasInput || hasReviewComments || hasImageAttachments;
  const shouldShowStop = canStop && onStop !== undefined;
  const isComposerActiveRun = isLoading || canStop || shouldShowStop;
  const canSendMessage = canSubmit && !isComposerActiveRun;
  const effectivePlaceholder =
    placeholder ?? (mode === "plan" ? PLAN_PLACEHOLDER : BUILD_PLACEHOLDER);
  const suggestionEntries = useMemo(
    () =>
      repoTree.map((entry) => ({
        path: entry.path,
        type: entry.type,
      })),
    [repoTree],
  );
  const resolvedCursorPosition =
    cursorPosition > 0 ? cursorPosition : input.length;
  const activeMention = useMemo(
    () => findActiveFileMention(input, resolvedCursorPosition),
    [input, resolvedCursorPosition],
  );
  const activeMentionKey = activeMention
    ? `${activeMention.start}:${activeMention.end}:${activeMention.query}`
    : null;
  const filePickerListId = `chat-input-file-picker-${sessionId}`;
  const suggestedFiles = useMemo(
    () =>
      activeMention
        ? filterFileMentionCandidates(
            suggestionEntries.map((entry) => entry.path),
            activeMention.query,
          )
        : [],
    [activeMention, suggestionEntries],
  );
  const suggestedEntries = useMemo(
    () =>
      suggestedFiles
        .map((path) => suggestionEntries.find((entry) => entry.path === path))
        .filter((entry): entry is { path: string; type: string } => entry !== undefined),
    [suggestedFiles, suggestionEntries],
  );
  const shouldShowFilePicker =
    activeMention !== null && dismissedMentionKey !== activeMentionKey;
  const isModelPickerLoading = useMemo(
    () =>
      isProviderModelBootstrapLoading({
        status,
        catalog,
        credentials,
        providerModels,
      }),
    [status, catalog, credentials, providerModels],
  );
  const isSelectedProviderModelHydrationPending = useMemo(
    () =>
      isProviderVisibleModelHydrationPending({
        selectedProviderId,
        providerModels,
        visibleModelIds,
        manageProviderModels: manageProviderModels ?? {},
      }),
    [manageProviderModels, providerModels, selectedProviderId, visibleModelIds],
  );
  const highlightedSuggestionIndex =
    suggestedEntries.length === 0
      ? 0
      : Math.min(
          mentionNavigationKey === activeMentionKey ? highlightedFileIndex : 0,
          suggestedEntries.length - 1,
        );
  const activeSuggestionId =
    shouldShowFilePicker && suggestedEntries[highlightedSuggestionIndex]
      ? `${filePickerListId}-option-${highlightedSuggestionIndex}`
      : undefined;
  const selectedModel = selectedProviderId
    ? providerModels[selectedProviderId]?.find(
        (model) => model.id === selectedModelId,
      ) ??
      manageProviderModels?.[selectedProviderId]?.find(
        (model) => model.id === selectedModelId,
      )
    : undefined;
  const selectedModelAllowsImages =
    selectedModel?.inputModalities?.image === true &&
    selectedModel.capabilityMetadata !== undefined &&
    selectedModel.capabilityMetadata?.confidence !== "unknown";

  useEffect(() => {
    imageAttachmentsRef.current = imageAttachments;
  }, [imageAttachments]);

  useEffect(
    () => () => {
      for (const attachment of imageAttachmentsRef.current) {
        URL.revokeObjectURL(attachment.previewUrl);
      }
    },
    [],
  );

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      const maxHeight = hasInput ? 200 : 400;
      const newHeight = Math.min(textareaRef.current.scrollHeight, maxHeight);
      textareaRef.current.style.height = newHeight + "px";
    }
  }, [input, hasInput]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || document.activeElement !== textarea) {
      return;
    }

    const liveSelectionStart = textarea.selectionStart;
    if (
      typeof liveSelectionStart === "number" &&
      liveSelectionStart !== cursorPosition
    ) {
      setCursorPosition(liveSelectionStart);
    }
  }, [input, cursorPosition]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (shouldShowFilePicker) {
      if (e.key === "ArrowDown" && suggestedFiles.length > 0) {
        e.preventDefault();
        setMentionNavigationKey(activeMentionKey);
        setHighlightedFileIndex((current) =>
          current >= suggestedFiles.length - 1 ? 0 : current + 1,
        );
        return;
      }

      if (e.key === "ArrowUp" && suggestedFiles.length > 0) {
        e.preventDefault();
        setMentionNavigationKey(activeMentionKey);
        setHighlightedFileIndex((current) =>
          current <= 0 ? suggestedFiles.length - 1 : current - 1,
        );
        return;
      }

      if (
        (e.key === "Enter" || e.key === "Tab") &&
        suggestedFiles.length > 0 &&
        !e.shiftKey
      ) {
        e.preventDefault();
    const selectedPath =
          suggestedFiles[highlightedSuggestionIndex] ?? suggestedFiles[0];
        if (selectedPath) {
          selectSuggestedFile(selectedPath);
        }
        return;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        setDismissedMentionKey(activeMentionKey);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (isComposerActiveRun) {
        return;
      }
      if (canSendMessage) {
        void submitComposer();
      }
    }
  };

  const submitComposer = async () => {
    if (hasImageAttachments && mode !== "build") {
      setImageAttachmentError("Image attachments are only supported in Build mode.");
      return;
    }
    if (hasImageAttachments && !selectedModelAllowsImages) {
      setImageAttachmentError(
        "Selected model only allows text. Choose a vision-capable model to attach images.",
      );
      return;
    }
    if (hasImageAttachments && hasReviewComments) {
      setImageAttachmentError(
        "Remove image attachments before sending selected review comments.",
      );
      return;
    }
    const submitted = await onSubmit(
      hasImageAttachments ? { imageAttachments } : undefined,
    );
    if (hasImageAttachments && submitted !== false) {
      clearImageAttachments();
    }
  };

  useEffect(() => {
    if (!onModelSelect || !lastResolvedConfig) {
      return;
    }
    onModelSelect(lastResolvedConfig.providerId, lastResolvedConfig.modelId);
  }, [lastResolvedConfig, onModelSelect]);

  useEffect(() => {
    if (!selectedProviderId || providerModels[selectedProviderId]) {
      return;
    }
    void loadProviderModels(selectedProviderId, {
      view: selectedModelView,
      append: false,
    });
  }, [
    loadProviderModels,
    providerModels,
    selectedModelView,
    selectedProviderId,
  ]);

  useEffect(() => {
    if (!selectedProviderId || !isSelectedProviderModelHydrationPending) {
      return;
    }
    if (loadingManageModelsForProviderIds?.[selectedProviderId]) {
      return;
    }
    if (!loadManageProviderModels) {
      return;
    }

    void loadManageProviderModels(selectedProviderId).catch((error) => {
      console.warn(
        "[chat-input/model-picker] failed to hydrate selected visible models",
        error,
      );
    });
  }, [
    isSelectedProviderModelHydrationPending,
    loadManageProviderModels,
    loadingManageModelsForProviderIds,
    selectedProviderId,
  ]);

  useEffect(() => {
    if (!switchWarningMessage) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setSwitchWarningMessage(null);
    }, WARNING_AUTO_DISMISS_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [switchWarningMessage, switchWarningTick]);

  const showSwitchWarning = (message: string) => {
    setSwitchWarningMessage(message);
    setSwitchWarningTick((value) => value + 1);
  };

  const guardActiveRunSwitch = () => {
    if (!isComposerActiveRun) {
      return false;
    }
    showSwitchWarning(ACTIVE_RUN_SWITCH_WARNING);
    return true;
  };

  const handleModeChange = (nextMode: RunMode) => {
    if (guardActiveRunSwitch()) {
      return;
    }
    if (nextMode !== "build" && hasImageAttachments) {
      showSwitchWarning("Remove image attachments before switching to Plan mode.");
      return;
    }
    onModeChange?.(nextMode);
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    void addImageFiles(files, "paste");
  };

  const addImageFiles = async (
    files: File[],
    source: "paste" | "upload",
  ) => {
    if (mode !== "build") {
      setImageAttachmentError("Image attachments are only supported in Build mode.");
      return;
    }
    if (!selectedModelAllowsImages) {
      setImageAttachmentError(
        "Selected model only allows text. Choose a vision-capable model to attach images.",
      );
      return;
    }

    let nextAttachments = imageAttachments;
    for (const file of files) {
      const validationError = validateNextImageAttachment({
        file,
        existingAttachments: nextAttachments,
      });
      if (validationError) {
        setImageAttachmentError(validationError);
        continue;
      }
      const attachment = await createChatImageAttachment(file, source);
      nextAttachments = [...nextAttachments, attachment];
    }
    setImageAttachments(nextAttachments);
    if (nextAttachments.length !== imageAttachments.length) {
      setImageAttachmentError(null);
    }
  };

  const removeImageAttachment = (attachmentId: string) => {
    setImageAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === attachmentId);
      if (removed) {
        URL.revokeObjectURL(removed.previewUrl);
      }
      return current.filter((attachment) => attachment.id !== attachmentId);
    });
  };

  const clearImageAttachments = () => {
    for (const attachment of imageAttachments) {
      URL.revokeObjectURL(attachment.previewUrl);
    }
    setImageAttachments([]);
  };

  const selectSuggestedFile = (filePath: string) => {
    if (!activeMention) {
      return;
    }

    const insertedPath = getPreferredMentionPath(
      filePath,
      suggestionEntries.map((entry) => entry.path),
    );
    const { nextValue, nextCaret } = applyFileMention(
      input,
      activeMention,
      filePath,
      insertedPath,
    );
    onChange(nextValue);
    setDismissedMentionKey(null);
    setMentionNavigationKey(null);
    setCursorPosition(nextCaret);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }
      textarea.focus();
      textarea.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const insertMentionTrigger = () => {
    const textarea = textareaRef.current;
    const selectionStart = textarea?.selectionStart ?? input.length;
    const selectionEnd = textarea?.selectionEnd ?? selectionStart;
    const previousCharacter = input[selectionStart - 1];
    const mentionTrigger =
      previousCharacter && !/\s/.test(previousCharacter) ? " @" : "@";
    const nextValue =
      input.slice(0, selectionStart) +
      mentionTrigger +
      input.slice(selectionEnd);

    onChange(nextValue);
    setDismissedMentionKey(null);
    setMentionNavigationKey(null);
    const nextCaret = selectionStart + mentionTrigger.length;
    setCursorPosition(nextCaret);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }
      textarea.focus();
      textarea.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const syncCursorPosition = () => {
    setCursorPosition(textareaRef.current?.selectionStart ?? input.length);
  };

  return (
    <>
      {switchWarningMessage ? (
        <motion.div
          initial={{ opacity: 0, y: -12, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.2 }}
          className="fixed left-1/2 top-4 z-[90] -translate-x-1/2 px-4"
          aria-live="polite"
          aria-atomic="true"
        >
          <div
            role="status"
            className="ui-surface-popover flex items-center gap-3 px-4 py-2 text-sm text-zinc-100"
          >
            <span>{switchWarningMessage}</span>
            <button
              type="button"
              onClick={() => setSwitchWarningMessage(null)}
              className="rounded p-0.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
              aria-label="Dismiss model switch warning"
            >
              <X size={14} />
            </button>
          </div>
        </motion.div>
      ) : null}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSendMessage) {
            void submitComposer();
          }
        }}
        className={
          layout === "hero"
            ? "relative w-full max-w-4xl mx-auto"
            : "relative w-full max-w-4xl mx-auto px-4 pb-3"
        }
      >
        {shouldShowFilePicker ? (
          <div className="ui-surface-popover absolute inset-x-5 bottom-full z-30 mb-2 overflow-hidden">
            <div
              id={filePickerListId}
              role="listbox"
              aria-label="Repository files"
              className="max-h-[19rem] overflow-y-auto p-2"
            >
              {isLoadingRepoTree ? (
                <div className="px-3 py-4 text-[11px] text-zinc-500">
                  Loading repository files...
                </div>
              ) : suggestedEntries.length === 0 ? (
                <div className="px-3 py-4 text-[11px] text-zinc-500">
                  No files match <span className="font-medium text-zinc-200">@{activeMention?.query ?? ""}</span>
                </div>
              ) : (
                suggestedEntries.map((entry, index) => {
                  const lastSlashIndex = entry.path.lastIndexOf("/");
                  const directory =
                    lastSlashIndex >= 0 ? entry.path.slice(0, lastSlashIndex) : "";
                  const Icon = getSuggestionIcon(entry.path, entry.type);

                  return (
                    <button
                      key={entry.path}
                      id={`${filePickerListId}-option-${index}`}
                      type="button"
                      role="option"
                      aria-selected={index === highlightedSuggestionIndex}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        selectSuggestedFile(entry.path);
                      }}
                      className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors ${
                        index === highlightedSuggestionIndex
                          ? "bg-[#2b2b2d] text-white"
                          : "text-zinc-300 hover:bg-white/[0.04]"
                      }`}
                    >
                      <div className="flex h-5 w-5 shrink-0 items-center justify-center">
                        <Icon
                          size={15}
                          strokeWidth={1.9}
                          className={getSuggestionIconClass(entry.path, entry.type)}
                        />
                      </div>
                      <div className="min-w-0 flex items-baseline gap-1 overflow-hidden">
                        <span className="truncate text-[13px] font-medium text-zinc-100">
                          {entry.path}
                        </span>
                        {directory ? (
                          <span className="truncate text-[11px] text-zinc-600">
                            {directory}
                          </span>
                        ) : null}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        ) : null}

        <div
          className={`
            ui-control-surface p-3
            transition-all duration-200
            ${isFocused ? "shadow-lg shadow-black/20" : ""}
          `}
        >
          {hasReviewComments ? (
            <div className="mb-3 space-y-2">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
                <span>{reviewComments.length} local review comment{reviewComments.length === 1 ? "" : "s"}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {reviewComments.map((comment) => {
                  const isExpanded = expandedReviewCommentId === comment.id;
                  return (
                    <div
                      key={comment.id}
                      className="relative inline-flex items-center gap-1 rounded-full border border-zinc-700 bg-zinc-900/90 pr-1"
                    >
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedReviewCommentId((current) =>
                            current === comment.id ? null : comment.id,
                          )
                        }
                        className="rounded-full px-3 py-1.5 text-xs text-zinc-200 transition-colors hover:bg-zinc-800"
                      >
                        {getReviewCommentDisplayLabel(comment)}
                      </button>
                      {onRemoveReviewComment ? (
                        <button
                          type="button"
                          onClick={() => {
                            onRemoveReviewComment(comment.id);
                            setExpandedReviewCommentId((current) =>
                              current === comment.id ? null : current,
                            );
                          }}
                          className="rounded-full p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
                          aria-label={`Remove ${getReviewCommentDisplayLabel(comment)} from review request`}
                        >
                          <X size={12} />
                        </button>
                      ) : null}
                      {isExpanded ? (
                        <div className="ui-surface-popover absolute left-0 top-full z-20 mt-2 w-80 max-w-[80vw] p-3 text-left">
                          <div className="text-xs font-semibold text-zinc-100">
                            {comment.filePath}
                          </div>
                          <div className="mt-1 text-[11px] uppercase tracking-[0.16em] text-zinc-500">
                            Line {comment.line}
                          </div>
                          {comment.linePreview ? (
                            <div className="mt-2 rounded-md border border-zinc-800 bg-black/40 px-2 py-1 font-mono text-[11px] text-zinc-400">
                              {comment.linePreview}
                            </div>
                          ) : null}
                          <p className="mt-2 text-sm leading-6 text-zinc-200">
                            {comment.note}
                          </p>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {hasImageAttachments ? (
            <div className="mb-3 flex flex-wrap gap-2">
              {imageAttachments.map((attachment, index) => (
                <div
                  key={attachment.id}
                  className="relative h-20 w-20 overflow-hidden rounded-md border border-zinc-700 bg-zinc-900"
                >
                  <img
                    src={attachment.previewUrl}
                    alt={`Attached image ${index + 1}: ${attachment.name}, ${attachment.mediaType}, ${formatAttachmentSize(attachment.byteSize)}`}
                    className="h-full w-full object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => removeImageAttachment(attachment.id)}
                    className="absolute right-1 top-1 rounded-full bg-white p-1 text-black shadow transition hover:bg-zinc-200"
                    aria-label={`Remove attached image ${index + 1}`}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              onChange(e.target.value);
              setCursorPosition(e.target.selectionStart ?? e.target.value.length);
              setDismissedMentionKey(null);
            }}
            onPaste={handlePaste}
            onKeyDown={handleKeyDown}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            onClick={syncCursorPosition}
            onKeyUp={syncCursorPosition}
            onSelect={syncCursorPosition}
            aria-autocomplete="list"
            aria-controls={shouldShowFilePicker ? filePickerListId : undefined}
            aria-expanded={shouldShowFilePicker}
            aria-activedescendant={activeSuggestionId}
            placeholder={effectivePlaceholder}
            rows={1}
            className={`w-full bg-transparent text-sm text-white placeholder-zinc-500 focus:outline-none resize-none overflow-hidden min-h-[20px] ${hasInput ? "max-h-[200px]" : "max-h-[400px]"}`}
            style={{ lineHeight: "1.5" }}
          />

          {mode === "plan" ? (
            <div className="mt-3 rounded-xl border border-cyan-900/60 bg-cyan-950/20 px-3 py-2 text-xs text-cyan-100">
              <div className="font-semibold uppercase tracking-[0.18em] text-cyan-300">
                Plan Mode
              </div>
              <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                <span>
                  Plan mode inspects and outlines steps without running normal
                  mutating execution.
                </span>
                {onModeChange ? (
                  <button
                    type="button"
                    onClick={() => handleModeChange("build")}
                    className="rounded-full border border-cyan-700/70 px-2.5 py-1 font-medium text-cyan-100 transition hover:border-cyan-500 hover:bg-cyan-900/40"
                  >
                    Switch to Build
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          {reviewCommentError ? (
            <div className="ui-control-surface mt-3 px-3 py-2 text-xs text-amber-100">
              {reviewCommentError}
            </div>
          ) : null}

          {imageAttachmentError ? (
            <div className="ui-control-surface mt-3 px-3 py-2 text-xs text-amber-100">
              {imageAttachmentError}
            </div>
          ) : null}

          {WEB_PROVIDER_POLICY.isByokFirstProduction &&
          credentials.length === 0 ? (
            <div className="ui-control-surface mt-3 px-3 py-2 text-xs text-zinc-300">
              Connect a BYOK provider to pick a model before sending prompts.
              <button
                type="button"
                onClick={() => {
                  setProviderDialogInitialTab("available");
                  setProviderDialogInitialView("default");
                  setProviderDialogVariant("connect-only");
                  setShowProviderDialog(true);
                }}
                className="ml-1 text-cyan-300 hover:text-cyan-200 underline-offset-2 hover:underline"
              >
                Open provider setup
              </button>
              .
            </div>
          ) : null}

          {/* Toolbar */}
          <div className="flex items-center justify-between mt-2 pt-2">
            {/* Left: Add button + Model picker */}
            <div className="flex items-center gap-1.5">
              <ChatComposerPlusMenu
                mode={mode}
                disabled={isComposerActiveRun}
                onModeChange={handleModeChange}
                onAddFiles={insertMentionTrigger}
              />

              <div className="h-3.5 w-px bg-zinc-700/80" />

              <ModelPickerPopover
                catalog={catalog}
                credentials={credentials}
                providerModels={providerModels}
                visibleModelIds={visibleModelIds}
                selectedProviderId={selectedProviderId}
                selectedModelId={selectedModelId}
                selectedModelView={selectedModelView}
                selectedProviderMetadata={
                  selectedProviderId
                    ? (providerModelsMetadata[selectedProviderId] ?? null)
                    : null
                }
                hasMoreSelectedProviderModels={
                  selectedProviderId
                    ? (providerModelsPage[selectedProviderId]?.hasMore ?? false)
                    : false
                }
                isLoadingMoreSelectedProviderModels={
                  selectedProviderId !== null &&
                  loadingModelsForProviderId === selectedProviderId
                }
                isRefreshingSelectedProviderModels={
                  selectedProviderId !== null &&
                  refreshingModelsForProviderId === selectedProviderId
                }
                onSelectModel={async (providerId, modelId) => {
                  if (guardActiveRunSwitch()) {
                    return;
                  }
                  const credential = findCredentialByProviderId(
                    credentials,
                    providerId,
                  );
                  if (!credential) {
                    setProviderDialogInitialTab("available");
                    setProviderDialogInitialView("default");
                    setProviderDialogVariant("connect-only");
                    setShowProviderDialog(true);
                    return;
                  }
                  const nextModel =
                    providerModels[providerId]?.find(
                      (model) => model.id === modelId,
                    ) ??
                    manageProviderModels?.[providerId]?.find(
                      (model) => model.id === modelId,
                    );
                  const nextModelAllowsImages =
                    nextModel?.inputModalities?.image === true &&
                    nextModel.capabilityMetadata !== undefined &&
                    nextModel.capabilityMetadata?.confidence !== "unknown";
                  if (hasImageAttachments && !nextModelAllowsImages) {
                    showSwitchWarning(
                      "Remove image attachments before switching to a text-only model.",
                    );
                    return;
                  }
                  if (hasMessages && !isComposerActiveRun) {
                    showSwitchWarning(IDLE_SWITCH_WARNING);
                  }
                  await applySessionSelection({
                    providerId,
                    credentialId: credential.credentialId,
                    modelId,
                  });
                }}
                onSelectModelView={setModelView}
                onLoadMoreSelectedProviderModels={loadMoreProviderModels}
                onRefreshSelectedProviderModels={refreshProviderModels}
                onConnectProvider={() => {
                  setProviderDialogInitialTab("available");
                  setProviderDialogInitialView("default");
                  setProviderDialogVariant("connect-only");
                  setShowProviderDialog(true);
                }}
                onManageModels={() => {
                  setProviderDialogInitialTab("connected");
                  setProviderDialogInitialView("manage-models");
                  setProviderDialogVariant("manage-models-only");
                  setShowProviderDialog(true);
                }}
                isLoading={isModelPickerLoading}
                isHydratingVisibleModels={isSelectedProviderModelHydrationPending}
              />

              {selectedProviderId === AXIS_PROVIDER_ID &&
              axisQuota &&
              canShowProviderInPrimaryUi(WEB_PROVIDER_POLICY, AXIS_PROVIDER_ID) ? (
                <span
                  className="rounded border border-emerald-800/60 bg-emerald-950/40 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300"
                  title={`Axis daily usage resets at ${new Date(axisQuota.resetsAt).toLocaleString()}`}
                >
                  Axis {axisQuota.used}/{axisQuota.limit}
                </span>
              ) : null}
            </div>

            {/* Attachment and voice actions stay hidden until they trigger real flows. */}
            <div className="flex items-center gap-1.5">
              <motion.button
                type="button"
                onClick={shouldShowStop ? onStop : () => void submitComposer()}
                disabled={shouldShowStop ? false : !canSendMessage}
                aria-label={shouldShowStop ? "Stop generation" : "Send message"}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                className={`
                  p-1.5 rounded-full transition-all
                  ${
                    shouldShowStop
                      ? "bg-white text-black hover:bg-zinc-200"
                      : canSubmit
                        ? "bg-white text-black hover:bg-zinc-200"
                        : "bg-zinc-800 text-zinc-600 cursor-not-allowed"
                  }
                `}
              >
                {shouldShowStop ? <Square size={14} /> : <ArrowUp size={16} />}
              </motion.button>
            </div>
          </div>
        </div>
      </form>
      <ProviderDialog
        isOpen={showProviderDialog}
        onClose={() => {
          setShowProviderDialog(false);
          setProviderDialogInitialTab(undefined);
          setProviderDialogInitialView("default");
          setProviderDialogVariant("full");
        }}
        mode="composer"
        initialTab={providerDialogInitialTab}
        initialView={providerDialogInitialView}
        variant={providerDialogVariant}
      />
    </>
  );
}

function getSuggestionIcon(path: string, entryType: string) {
  if (entryType === "tree") {
    return Folder;
  }

  if (path.endsWith(".tsx") || path.endsWith(".ts") || path.endsWith(".jsx") || path.endsWith(".js")) {
    return FileCode2;
  }

  if (path.endsWith(".md")) {
    return Info;
  }

  if (path.endsWith(".sh")) {
    return TerminalSquare;
  }

  return FileText;
}

function getSuggestionIconClass(path: string, entryType: string): string {
  if (entryType === "tree") {
    return "text-blue-400";
  }

  if (
    path.endsWith(".tsx") ||
    path.endsWith(".ts") ||
    path.endsWith(".jsx") ||
    path.endsWith(".js")
  ) {
    return "text-sky-400";
  }

  if (path.endsWith(".md")) {
    return "text-blue-400";
  }

  if (path.endsWith(".sh")) {
    return "text-orange-400";
  }

  return "text-zinc-300";
}
