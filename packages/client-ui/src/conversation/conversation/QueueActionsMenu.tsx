import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CornerDownRight, MoreHorizontal, Pencil } from "lucide-react";
import { shouldIgnoreGlobalKeyDown } from "../../hooks/global-keydown.js";
import { useOutsideDismiss } from "../../hooks/useOutsideDismiss.js";
import { getVisibleViewportBounds, useViewportPopoverPosition } from "../../hooks/useViewportPopoverPosition.js";

export function QueueActionsMenu({ queuingEnabled, onEdit, onQueuingChange, disabled = false }: {
  queuingEnabled: boolean;
  onEdit: () => void;
  onQueuingChange: (enabled: boolean) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const isOpen = open && !disabled;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef(false);
  const additionalRefs = useMemo(() => [triggerRef], []);
  const position = useViewportPopoverPosition(isOpen, triggerRef, menuRef, { gap: 4, placement: "auto" });
  const close = useCallback(() => { pendingFocus.current = false; setOpen(false); }, []);
  useOutsideDismiss(menuRef, isOpen, close, { additionalRefs, escapeFocusRef: triggerRef });
  useEffect(() => { if (disabled) close(); }, [disabled, close]);
  useEffect(() => {
    if (!isOpen || position.visibility !== "visible" || !pendingFocus.current) return;
    pendingFocus.current = false;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [isOpen, position.visibility]);
  useEffect(() => {
    if (!isOpen) return;
    // Position comes from the canonical hook; this guard only dismisses an
    // action menu after its queued row scrolls outside the visible region.
    const dismissClippedTrigger = () => {
      const trigger = triggerRef.current;
      if (!trigger) return close();
      const rectangle = trigger.getBoundingClientRect();
      const visible = getVisibleViewportBounds();
      if (rectangle.bottom <= visible.top || rectangle.top >= visible.bottom ||
          rectangle.right <= visible.left || rectangle.left >= visible.right) return close();
      for (let ancestor = trigger.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
        if (!/(auto|scroll|hidden|clip)/.test(window.getComputedStyle(ancestor).overflowY)) continue;
        const bounds = ancestor.getBoundingClientRect();
        if (rectangle.bottom <= bounds.top || rectangle.top >= bounds.bottom) return close();
      }
    };
    dismissClippedTrigger();
    const viewport = window.visualViewport;
    window.addEventListener("scroll", dismissClippedTrigger, true);
    window.addEventListener("resize", dismissClippedTrigger);
    viewport?.addEventListener("resize", dismissClippedTrigger);
    viewport?.addEventListener("scroll", dismissClippedTrigger);
    return () => {
      window.removeEventListener("scroll", dismissClippedTrigger, true);
      window.removeEventListener("resize", dismissClippedTrigger);
      viewport?.removeEventListener("resize", dismissClippedTrigger);
      viewport?.removeEventListener("scroll", dismissClippedTrigger);
    };
  }, [isOpen, close]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (shouldIgnoreGlobalKeyDown(event.nativeEvent)) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])'));
    const current = items.findIndex((item) => item === document.activeElement);
    const next = event.key === "ArrowDown" ? (current + 1) % items.length
      : event.key === "ArrowUp" ? current <= 0 ? items.length - 1 : current - 1
        : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : null;
    if (next !== null && items.length) { event.preventDefault(); items[next]?.focus(); }
  };
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-label="More queued message actions"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        title="More actions"
        className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-200 focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-400 disabled:cursor-wait disabled:opacity-50"
        onClick={() => {
          if (isOpen) close();
          else { pendingFocus.current = true; setOpen(true); }
        }}
      ><MoreHorizontal size={17} aria-hidden="true" /></button>
      {isOpen ? createPortal(
        <div
          ref={menuRef}
          role="menu"
          className="ui-surface-popover fixed z-50 w-48 overflow-y-auto overscroll-contain p-1 shadow-2xl"
          style={position}
          onKeyDown={onKeyDown}
          onBlur={(event) => {
            const next = event.relatedTarget;
            if (!(next instanceof Node) || (!event.currentTarget.contains(next) && !triggerRef.current?.contains(next))) close();
          }}
        >
          <button type="button" role="menuitem" className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-zinc-200 hover:bg-white/[0.06] focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-400" onClick={() => { close(); onEdit(); }}>
            <Pencil size={14} aria-hidden="true" className="text-zinc-400" />Edit message
          </button>
          <button type="button" role="menuitem" className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-zinc-200 hover:bg-white/[0.06] focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-400" onClick={() => { close(); triggerRef.current?.focus(); onQueuingChange(!queuingEnabled); }}>
              <CornerDownRight size={14} aria-hidden="true" className="text-zinc-400" />{queuingEnabled ? "Turn off queuing" : "Turn on queuing"}
          </button>
        </div>, document.body,
      ) : null}
    </>
  );
}
