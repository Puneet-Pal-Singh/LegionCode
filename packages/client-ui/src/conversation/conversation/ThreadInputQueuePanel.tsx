import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  CornerDownRight,
  Image as ImageIcon,
  List,
  MoreHorizontal,
  Pencil,
  Play,
  Trash2,
} from "lucide-react";
import type {
  ThreadInputQueueSnapshot,
  ThreadInputReceipt,
} from "@legioncode/sdk";

interface ThreadInputQueuePanelProps {
  snapshot: ThreadInputQueueSnapshot | null;
  error: string | null;
  active: boolean;
  queuingEnabled: boolean;
  onDisableQueuing: () => void;
  onUpdate: (
    itemId: string,
    version: number,
    text: string,
  ) => Promise<ThreadInputReceipt | null>;
  onRemove: (
    itemId: string,
    version: number,
  ) => Promise<ThreadInputReceipt | null>;
  onSteer?: (
    itemId: string,
    version: number,
  ) => Promise<ThreadInputReceipt | null>;
  onStart?: (
    itemId: string,
    version: number,
    revision: number,
  ) => Promise<ThreadInputReceipt | null>;
  resolveImageSource?: (attachmentId: string) => string | undefined;
}

export function ThreadInputQueuePanel(props: ThreadInputQueuePanelProps) {
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editingVersion, setEditingVersion] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const items =
    props.snapshot?.items.filter(
      (item) =>
        item.state === "pending" ||
        item.state === "consuming" ||
        item.receipt?.status === "unconfirmed",
    ) ?? [];
  const queuedCount = items.filter(
    (item) => item.delivery === "queue" && item.state === "pending",
  ).length;
  if (!props.snapshot && !props.error) {
    return null;
  }
  if (
    props.snapshot &&
    items.length === 0 &&
    !props.snapshot.paused &&
    !props.error
  ) {
    return null;
  }

  return (
    <section
      aria-label={`Queued follow-ups${queuedCount ? ` (${queuedCount})` : ""}`}
      className="relative rounded-t-2xl border border-zinc-800/80 border-b-0 bg-[#242425] px-2.5 py-1.5 sm:px-3"
    >
      {props.snapshot?.paused ? (
        <div className="flex min-h-8 items-center gap-2 px-1 text-[11px] text-amber-200">
          <span className="min-w-0 flex-1 truncate">
            Queue paused
            {props.snapshot.pauseReason
              ? `: ${props.snapshot.pauseReason}`
              : "."}
          </span>
          {items.length === 0 && props.queuingEnabled ? (
            <button
              type="button"
              className="shrink-0 rounded-md px-2 py-1 text-zinc-300 hover:bg-white/[0.06] hover:text-white focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-400"
              onClick={props.onDisableQueuing}
            >
              Turn off queuing
            </button>
          ) : null}
        </div>
      ) : null}
      {props.error ? (
        <p role="alert" className="px-1 py-1 text-[11px] text-rose-300">
          {props.error}
        </p>
      ) : null}
      <ol className="max-h-[min(28vh,10rem)] space-y-0 overflow-y-auto overscroll-contain">
        {items.map((item) => {
          const image = item.mediaRefs[0];
          const imageSource = image
            ? props.resolveImageSource?.(image.attachmentId)
            : undefined;
          const canEditOrRemove =
            item.state === "pending" && item.delivery === "queue";
          const status =
            item.receipt?.status === "unconfirmed"
              ? "Input delivery could not be confirmed."
              : item.delivery === "steer" && item.receipt?.status === "applied"
                ? `Applied at model step ${item.receipt.modelStep}`
                : item.delivery === "steer" &&
                    item.receipt?.status === "accepted"
                  ? "Steering pending delivery"
                  : item.state === "consuming" ||
                      item.receipt?.status === "started"
                    ? "Starting in a new run"
                    : null;
          return (
            <li
              key={item.itemId}
              className="relative flex min-w-0 items-center gap-2 border-b border-zinc-700/50 px-1.5 py-1.5 last:border-b-0 sm:gap-2.5 sm:px-2"
            >
              {editingItemId === item.itemId ? (
                <div className="flex min-w-0 flex-1 items-center gap-2 py-1">
                  <List
                    size={17}
                    aria-hidden="true"
                    className="shrink-0 text-zinc-500"
                  />
                  <textarea
                    aria-label="Edit queued follow-up"
                    className="min-h-9 min-w-0 flex-1 resize-y rounded-lg border border-zinc-700 bg-zinc-900/80 p-2 text-xs text-zinc-100 outline-none focus-visible:border-zinc-500 focus-visible:ring-1 focus-visible:ring-zinc-500"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                  />
                  <button
                    type="button"
                    className="shrink-0 rounded-lg px-2.5 py-1.5 text-xs text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200 focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-400"
                    onClick={() => {
                      setEditingItemId(null);
                      setEditingVersion(null);
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="shrink-0 rounded-lg bg-zinc-700 px-2.5 py-1.5 text-xs text-white hover:bg-zinc-600 focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-300"
                    onClick={async () => {
                      if (editingVersion === null) return;
                      const result = await props.onUpdate(
                        item.itemId,
                        editingVersion,
                        draft,
                      );
                      if (result?.status === "pending") {
                        setEditingItemId(null);
                        setEditingVersion(null);
                      }
                    }}
                  >
                    Save
                  </button>
                </div>
              ) : (
                <>
                  {image ? (
                    imageSource ? (
                      <img
                        src={imageSource}
                        alt={image.name}
                        className="h-8 w-8 shrink-0 rounded-md border border-zinc-700/80 object-cover"
                      />
                    ) : (
                      <span
                        aria-label={`Image attachment: ${image.name}`}
                        role="img"
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-zinc-700/80 bg-zinc-900 text-zinc-500"
                      >
                        <ImageIcon size={15} aria-hidden="true" />
                      </span>
                    )
                  ) : (
                    <List
                      size={18}
                      aria-hidden="true"
                      className="shrink-0 text-zinc-500"
                    />
                  )}
                  <div className="min-w-0 flex-1 py-0.5">
                    <p
                      className="truncate text-[13px] leading-5 text-zinc-100"
                      title={item.text || "Image follow-up"}
                    >
                      {item.text || "Image follow-up"}
                    </p>
                    {status || item.mediaRefs.length > 1 ? (
                      <p className="truncate text-[10px] leading-4 text-zinc-400">
                        {status ?? `${item.mediaRefs.length} images attached`}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
                    {props.active && canEditOrRemove && props.onSteer ? (
                      <button
                        type="button"
                        className="inline-flex min-h-8 items-center gap-1.5 rounded-full px-2.5 text-xs text-zinc-300 transition-colors hover:bg-white/[0.07] hover:text-white focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-400 sm:px-3"
                        aria-label="Steer queued message"
                        title="Submit without interrupting the model"
                        onClick={() =>
                          void props.onSteer?.(item.itemId, item.version)
                        }
                      >
                        <CornerDownRight size={15} aria-hidden="true" />
                        <span>Steer</span>
                      </button>
                    ) : !props.active && canEditOrRemove && props.onStart ? (
                      <button
                        type="button"
                        className="inline-flex min-h-8 items-center gap-1.5 rounded-full px-2.5 text-xs text-zinc-300 transition-colors hover:bg-white/[0.07] hover:text-white focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-400 sm:px-3"
                        disabled={!props.snapshot}
                        onClick={() =>
                          void props.onStart?.(
                            item.itemId,
                            item.version,
                            props.snapshot!.revision,
                          )
                        }
                      >
                        <Play size={14} aria-hidden="true" />
                        <span>Start</span>
                      </button>
                    ) : null}
                    {canEditOrRemove ? (
                      <>
                        <button
                          type="button"
                          className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-200 focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-400"
                          aria-label="Remove queued message"
                          title="Remove queued message"
                          onClick={() =>
                            void props.onRemove(item.itemId, item.version)
                          }
                        >
                          <Trash2 size={16} aria-hidden="true" />
                        </button>
                        <QueueActionsMenu
                          queuingEnabled={props.queuingEnabled}
                          onEdit={() => {
                            setEditingItemId(item.itemId);
                            setEditingVersion(item.version);
                            setDraft(item.text);
                          }}
                          onDisableQueuing={props.onDisableQueuing}
                        />
                      </>
                    ) : null}
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function QueueActionsMenu({
  queuingEnabled,
  onEdit,
  onDisableQueuing,
}: {
  queuingEnabled: boolean;
  onEdit: () => void;
  onDisableQueuing: () => void;
}): React.ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuStyle, setMenuStyle] = useState<{
    top: number;
    left: number;
    maxHeight: number;
  } | null>(null);
  const pendingInitialFocusRef = useRef(false);

  const updateMenuPosition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const outsideViewport =
      rect.bottom <= 0 ||
      rect.top >= window.innerHeight ||
      rect.right <= 0 ||
      rect.left >= window.innerWidth;
    let clippedByScrollContainer = false;
    let ancestor = triggerRef.current?.parentElement ?? null;
    while (ancestor && ancestor !== document.body) {
      const overflowY = window.getComputedStyle(ancestor).overflowY;
      if (/(auto|scroll|hidden|clip)/.test(overflowY)) {
        const ancestorRect = ancestor.getBoundingClientRect();
        if (rect.bottom <= ancestorRect.top || rect.top >= ancestorRect.bottom) {
          clippedByScrollContainer = true;
          break;
        }
      }
      ancestor = ancestor.parentElement;
    }
    if (outsideViewport || clippedByScrollContainer) {
      pendingInitialFocusRef.current = false;
      setMenuStyle(null);
      setIsOpen(false);
      return;
    }
    const viewportPadding = 8;
    const gap = 4;
    const width = Math.min(192, window.innerWidth - viewportPadding * 2);
    const left = Math.min(
      Math.max(viewportPadding, rect.right - width),
      Math.max(viewportPadding, window.innerWidth - width - viewportPadding),
    );
    const measuredHeight =
      menuRef.current?.getBoundingClientRect().height ??
      (queuingEnabled ? 88 : 48);
    const spaceAbove = Math.max(0, rect.top - viewportPadding - gap);
    const spaceBelow = Math.max(
      0,
      window.innerHeight - rect.bottom - viewportPadding - gap,
    );
    const canFitBelow = spaceBelow >= measuredHeight;
    const canFitAbove = spaceAbove >= measuredHeight;
    const openBelow = canFitBelow || (!canFitAbove && spaceBelow >= spaceAbove);
    const availableHeight = openBelow ? spaceBelow : spaceAbove;
    setMenuStyle(
      {
        top: openBelow
          ? rect.bottom + gap
          : Math.max(
              viewportPadding,
              rect.top - Math.min(measuredHeight, availableHeight) - gap,
            ),
        left,
        maxHeight: availableHeight,
      },
    );
  }, [queuingEnabled]);

  const closeMenu = useCallback((restoreFocus = false) => {
    pendingInitialFocusRef.current = false;
    setIsOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const frame = requestAnimationFrame(updateMenuPosition);
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !triggerRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        closeMenu();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [closeMenu, isOpen, updateMenuPosition]);

  useEffect(() => {
    if (!isOpen || !menuStyle || !pendingInitialFocusRef.current) return;
    pendingInitialFocusRef.current = false;
    menuRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
      ?.focus();
  }, [isOpen, menuStyle]);

  const edit = () => {
    closeMenu();
    onEdit();
  };
  const disableQueuing = () => {
    closeMenu();
    onDisableQueuing();
  };

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not([disabled])',
      ),
    );
    const currentIndex = items.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % items.length;
    }
    if (event.key === "ArrowUp") {
      nextIndex = currentIndex <= 0 ? items.length - 1 : currentIndex - 1;
    }
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = items.length - 1;
    if (nextIndex !== null && items.length > 0) {
      event.preventDefault();
      items[nextIndex]?.focus();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(true);
    }
  };

  const handleMenuBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    if (
      !(nextTarget instanceof Node) ||
      (!event.currentTarget.contains(nextTarget) &&
        !triggerRef.current?.contains(nextTarget))
    ) {
      closeMenu();
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label="More queued message actions"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        title="More actions"
        className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-200 focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-400"
        onClick={() => {
          if (isOpen) {
            closeMenu();
          } else {
            pendingInitialFocusRef.current = true;
            setMenuStyle(null);
            setIsOpen(true);
          }
        }}
      >
        <MoreHorizontal size={17} aria-hidden="true" />
      </button>
      {isOpen
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              className={`ui-surface-popover fixed z-50 w-48 max-w-[calc(100vw-1rem)] overflow-y-auto overscroll-contain p-1 shadow-2xl ${menuStyle ? "" : "invisible"}`}
              style={menuStyle ?? undefined}
              onKeyDown={handleMenuKeyDown}
              onBlur={handleMenuBlur}
            >
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-zinc-200 transition-colors hover:bg-white/[0.06] focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-400"
                onClick={edit}
              >
                <Pencil
                  size={14}
                  aria-hidden="true"
                  className="text-zinc-400"
                />
                Edit message
              </button>
              {queuingEnabled ? (
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-zinc-200 transition-colors hover:bg-white/[0.06] focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-400"
                  onClick={disableQueuing}
                >
                  <CornerDownRight
                    size={14}
                    aria-hidden="true"
                    className="text-zinc-400"
                  />
                  Turn off queuing
                </button>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
