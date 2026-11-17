import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createChatImageAttachment,
  validateNextImageAttachment,
  type ChatImageAttachment,
} from "./chatImageAttachments.js";

type AttachmentSource = "paste" | "upload";

interface DraftCell {
  attachments: ChatImageAttachment[];
  readonly detached: Map<string, ChatImageAttachment>;
  error: string | null;
  dragging: boolean;
}
interface DraftOwner {
  active: boolean;
  generation: number;
  readonly cells: Map<string, DraftCell>;
}

export function useChatImageAttachmentDraft(
  enabled = true,
  initialAttachments: ChatImageAttachment[] = [],
  scope?: { readonly ownerKey?: string; readonly scopeKey?: string; readonly viewActive?: boolean },
) {
  const owner = useMemo<DraftOwner>(() => ({ active: true, generation: 0, cells: new Map() }), [scope?.ownerKey]);
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const key = scope?.scopeKey ?? "";
  let selected = owner.cells.get(key);
  if (!selected) {
    selected = { attachments: owner.cells.size === 0 ? initialAttachments : [],
      detached: new Map(), error: null, dragging: false };
    owner.cells.set(key, selected);
  }
  const cell = selected;
  const current = useRef({ owner, cell, enabled, viewActive: scope?.viewActive ?? true });
  current.current = { owner, cell, enabled, viewActive: scope?.viewActive ?? true };
  const captureLease = useRef<{ owner: DraftOwner; cell: DraftCell; enabled: boolean; viewActive: boolean } | null>(null);
  const [, setRevision] = useState(0);
  const isActive = useCallback(() => owner.active && currentOwner.current === owner, [owner]);
  const publish = useCallback(() => {
    if (owner.active && currentOwner.current === owner) setRevision((value) => value + 1);
  }, [owner]);
  const replaceAttachments = useCallback((next: ChatImageAttachment[]) => {
    if (!isActive()) return;
    cell.attachments = next;
    publish();
  }, [cell, isActive, publish]);
  const setError = useCallback((value: string | null) => {
    if (!isActive()) return;
    cell.error = value;
    publish();
  }, [cell, isActive, publish]);
  const setIsDraggingImages = useCallback((value: boolean) => {
    if (!isActive() || cell.dragging === value) return;
    cell.dragging = value;
    publish();
  }, [cell, isActive, publish]);

  const addFiles = useCallback(
    async (files: File[], source: AttachmentSource) => {
      const generation = owner.generation;
      const acceptsDelivery = () => isActive() && owner.generation === generation;
      let firstError: string | null = null;
      let added = false;

      for (const file of files) {
        if (!acceptsDelivery()) return;
        const validationError = validateNextImageAttachment({
          file,
          existingAttachments: cell.attachments,
        });
        if (validationError) {
          firstError ??= validationError;
          continue;
        }

        try {
          const attachment = await createChatImageAttachment(file, source);
          if (!acceptsDelivery()) {
            URL.revokeObjectURL(attachment.previewUrl);
            return;
          }
          const latestValidationError = validateNextImageAttachment({
            file,
            existingAttachments: cell.attachments,
          });
          if (latestValidationError) {
            URL.revokeObjectURL(attachment.previewUrl);
            firstError ??= latestValidationError;
            continue;
          }
          replaceAttachments([...cell.attachments, attachment]);
          added = true;
        } catch (attachmentError) {
          firstError ??=
            attachmentError instanceof Error
              ? attachmentError.message
              : "Image attachment could not be read.";
        }
      }

      if (!acceptsDelivery()) return;
      if (firstError) {
        setError(firstError);
      } else if (added) {
        setError(null);
      }
    },
    [cell, owner, isActive, replaceAttachments, setError],
  );

  const remove = useCallback(
    (attachmentId: string) => {
      if (!isActive()) return;
      const removed = cell.attachments.find(
        (attachment) => attachment.id === attachmentId,
      );
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      replaceAttachments(
        cell.attachments.filter(
          (attachment) => attachment.id !== attachmentId,
        ),
      );
      setError(null);
    },
    [cell, isActive, replaceAttachments, setError],
  );

  const clear = useCallback(() => {
    if (!isActive()) return;
    for (const attachment of cell.attachments) {
      URL.revokeObjectURL(attachment.previewUrl);
    }
    replaceAttachments([]);
    setError(null);
  }, [cell, isActive, replaceAttachments, setError]);

  const moveToScope = useCallback((targetKey: string): boolean => {
    if (!isActive()) return false;
    const target = owner.cells.get(targetKey);
    if (target === cell) return true;
    if (owner.cells.get(key) !== cell || target &&
        (target.attachments.length > 0 || target.detached.size > 0 || target.error !== null)) return false;
    owner.cells.set(targetKey, cell);
    owner.cells.delete(key);
    publish();
    return true;
  }, [owner, cell, key, isActive, publish]);

  const detachForSubmit = useCallback(() => {
    if (!isActive()) return [];
    const detached = cell.attachments;
    for (const attachment of detached) {
      cell.detached.set(attachment.id, attachment);
    }
    replaceAttachments([]);
    setError(null);
    return detached;
  }, [cell, isActive, replaceAttachments, setError]);

  const settleDetached = useCallback(
    (detached: readonly ChatImageAttachment[], accepted: boolean) => {
      if (!isActive()) {
        for (const attachment of detached) URL.revokeObjectURL(attachment.previewUrl);
        return;
      }
      for (const attachment of detached) {
        cell.detached.delete(attachment.id);
      }

      if (accepted) {
        for (const attachment of detached) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
        return;
      }

      const currentIds = new Set(
        cell.attachments.map((attachment) => attachment.id),
      );
      replaceAttachments([
        ...detached.filter((attachment) => !currentIds.has(attachment.id)),
        ...cell.attachments,
      ]);
    },
    [cell, isActive, replaceAttachments, setError],
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
  }, [setIsDraggingImages]);

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }
    setIsDraggingImages(false);
  }, [setIsDraggingImages]);

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      setIsDraggingImages(false);
      void addFiles(Array.from(event.dataTransfer.files), "upload");
    },
    [addFiles, setIsDraggingImages],
  );

  // Global listeners belong to this mounted hook, while each returned callback
  // retains its original draft cell across navigation and async settlement.
  const currentHandlers = useRef({ addFiles, setIsDraggingImages });
  currentHandlers.current = { addFiles, setIsDraggingImages };
  useEffect(() => {
    const selectedCapture = () => {
      const selected = current.current;
      const lease = captureLease.current;
      return lease?.owner === selected.owner && lease.cell === selected.cell
        ? { ...lease, viewActive: selected.viewActive && lease.viewActive } : selected;
    };
    const handleWindowDragOver = (event: DragEvent) => {
      const capture = selectedCapture();
      if (!event.dataTransfer?.types.includes("Files") || !capture.viewActive) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      if (capture.enabled) currentHandlers.current.setIsDraggingImages(true);
    };
    const handleWindowDrop = (event: DragEvent) => {
      const capture = selectedCapture();
      if (!event.dataTransfer?.types.includes("Files") || !capture.viewActive) return;
      const alreadyHandled = event.defaultPrevented;
      // A visible disabled/approval surface still prevents file navigation.
      // An inactive retained view yields ownership to the visible composer.
      event.preventDefault();
      currentHandlers.current.setIsDraggingImages(false);
      if (!capture.enabled || alreadyHandled) return;
      void currentHandlers.current.addFiles(Array.from(event.dataTransfer.files), "upload");
    };
    const clearWindowDragState = () => {
      if (selectedCapture().viewActive) currentHandlers.current.setIsDraggingImages(false);
    };
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
    };
  }, []);

  useEffect(() => {
    owner.active = true;
    return () => {
      owner.active = false;
      owner.generation += 1;
      if (captureLease.current?.owner === owner) captureLease.current = null;
      const urls = new Set<string>();
      for (const draft of owner.cells.values()) {
        for (const attachment of draft.attachments) urls.add(attachment.previewUrl);
        for (const attachment of draft.detached.values()) urls.add(attachment.previewUrl);
        draft.detached.clear();
      }
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [owner]);

  // An injected view leases capture eligibility and global event ownership
  // separately. A removed view cannot disable a newer view's lease.
  const bindCapture = useCallback((enabled: boolean, viewActive = true) => {
    if (!isActive() || current.current.owner !== owner || current.current.cell !== cell) return () => undefined;
    const lease = { owner, cell, enabled, viewActive };
    captureLease.current = lease;
    if (!enabled || !viewActive) setIsDraggingImages(false);
    return () => {
      if (captureLease.current !== lease) return;
      captureLease.current = null;
      setIsDraggingImages(false);
    };
  }, [owner, cell, isActive, setIsDraggingImages]);
  const reportError = setError;

  return {
    attachments: cell.attachments,
    error: cell.error,
    isDraggingImages: cell.dragging,
    addFiles,
    remove,
    clear,
    moveToScope,
    detachForSubmit,
    settleDetached,
    handlePaste,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    reportError,
    bindCapture,
  };
}

export type ChatImageAttachmentDraftBinding = ReturnType<typeof useChatImageAttachmentDraft>;
