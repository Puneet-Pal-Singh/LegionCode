import { useCallback, useEffect, useRef, useState } from "react";
import {
  createChatImageAttachment,
  validateNextImageAttachment,
  type ChatImageAttachment,
} from "./chatImageAttachments";

type AttachmentSource = "paste" | "upload";

export function useChatImageAttachmentDraft() {
  const attachmentsRef = useRef<ChatImageAttachment[]>([]);
  const detachedAttachmentsRef = useRef(new Map<string, ChatImageAttachment>());
  const [attachments, setAttachments] = useState<ChatImageAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isDraggingImages, setIsDraggingImages] = useState(false);

  const replaceAttachments = useCallback((next: ChatImageAttachment[]) => {
    attachmentsRef.current = next;
    setAttachments(next);
  }, []);

  const addFiles = useCallback(
    async (files: File[], source: AttachmentSource) => {
      let firstError: string | null = null;
      let added = false;

      for (const file of files) {
        const validationError = validateNextImageAttachment({
          file,
          existingAttachments: attachmentsRef.current,
        });
        if (validationError) {
          firstError ??= validationError;
          continue;
        }

        try {
          const attachment = await createChatImageAttachment(file, source);
          const latestValidationError = validateNextImageAttachment({
            file,
            existingAttachments: attachmentsRef.current,
          });
          if (latestValidationError) {
            URL.revokeObjectURL(attachment.previewUrl);
            firstError ??= latestValidationError;
            continue;
          }
          replaceAttachments([...attachmentsRef.current, attachment]);
          added = true;
        } catch (attachmentError) {
          firstError ??=
            attachmentError instanceof Error
              ? attachmentError.message
              : "Image attachment could not be read.";
        }
      }

      if (firstError) {
        setError(firstError);
      } else if (added) {
        setError(null);
      }
    },
    [replaceAttachments],
  );

  const remove = useCallback(
    (attachmentId: string) => {
      const removed = attachmentsRef.current.find(
        (attachment) => attachment.id === attachmentId,
      );
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      replaceAttachments(
        attachmentsRef.current.filter(
          (attachment) => attachment.id !== attachmentId,
        ),
      );
      setError(null);
    },
    [replaceAttachments],
  );

  const clear = useCallback(() => {
    for (const attachment of attachmentsRef.current) {
      URL.revokeObjectURL(attachment.previewUrl);
    }
    replaceAttachments([]);
    setError(null);
  }, [replaceAttachments]);

  const detachForSubmit = useCallback(() => {
    const detached = attachmentsRef.current;
    for (const attachment of detached) {
      detachedAttachmentsRef.current.set(attachment.id, attachment);
    }
    replaceAttachments([]);
    setError(null);
    return detached;
  }, [replaceAttachments]);

  const settleDetached = useCallback(
    (detached: readonly ChatImageAttachment[], accepted: boolean) => {
      for (const attachment of detached) {
        detachedAttachmentsRef.current.delete(attachment.id);
      }

      if (accepted) {
        for (const attachment of detached) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
        return;
      }

      const currentIds = new Set(
        attachmentsRef.current.map((attachment) => attachment.id),
      );
      replaceAttachments([
        ...detached.filter((attachment) => !currentIds.has(attachment.id)),
        ...attachmentsRef.current,
      ]);
    },
    [replaceAttachments],
  );

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(event.clipboardData.items)
        .filter(
          (item) => item.kind === "file" && item.type.startsWith("image/"),
        )
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
      if (files.length === 0) return;
      event.preventDefault();
      void addFiles(files, "paste");
    },
    [addFiles],
  );

  const handleDragOver = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDraggingImages(true);
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }
    setIsDraggingImages(false);
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      setIsDraggingImages(false);
      void addFiles(Array.from(event.dataTransfer.files), "upload");
    },
    [addFiles],
  );

  useEffect(
    () => {
      const detachedAttachments = detachedAttachmentsRef.current;
      const handleWindowDragOver = (event: DragEvent) => {
        if (!event.dataTransfer?.types.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setIsDraggingImages(true);
      };
      const handleWindowDrop = (event: DragEvent) => {
        if (!event.dataTransfer?.types.includes("Files")) return;
        // A drop on the composer already ran the scoped handler. The window
        // listener only owns drops over the surrounding chat surface.
        if (event.defaultPrevented) return;
        event.preventDefault();
        setIsDraggingImages(false);
        void addFiles(Array.from(event.dataTransfer.files), "upload");
      };
      const clearWindowDragState = () => setIsDraggingImages(false);
      const handleWindowDragLeave = (event: DragEvent) => {
        if (event.relatedTarget === null) clearWindowDragState();
      };

      window.addEventListener("dragover", handleWindowDragOver);
      window.addEventListener("drop", handleWindowDrop);
      window.addEventListener("dragend", clearWindowDragState);
      window.addEventListener("dragleave", handleWindowDragLeave);
      return () => {
        window.removeEventListener("dragover", handleWindowDragOver);
        window.removeEventListener("drop", handleWindowDrop);
        window.removeEventListener("dragend", clearWindowDragState);
        window.removeEventListener("dragleave", handleWindowDragLeave);
        for (const attachment of attachmentsRef.current) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
        for (const attachment of detachedAttachments.values()) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
        detachedAttachments.clear();
      };
    },
    [addFiles],
  );

  return {
    attachments,
    error,
    isDraggingImages,
    addFiles,
    remove,
    clear,
    detachForSubmit,
    settleDetached,
    handlePaste,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    reportError: setError,
  };
}
