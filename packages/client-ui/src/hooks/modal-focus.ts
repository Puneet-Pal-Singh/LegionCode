import { useEffect, useRef, type RefObject } from "react";
import { shouldIgnoreGlobalKeyDown } from "./global-keydown.js";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Existing workspace visibility policy, including hidden ancestors. */
export function isVisibleFocusTarget(element: HTMLElement): boolean {
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    const style = window.getComputedStyle(current);
    if (current.hidden || current.hasAttribute("inert") || style.display === "none" ||
        style.visibility === "hidden" || style.visibility === "collapse") return false;
  }
  return true;
}

export function getVisibleFocusTargets(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => element.tabIndex >= 0 && !element.matches(":disabled") && isVisibleFocusTarget(element));
}

/** One open dialog's focus lifetime; there is no global modal registry. */
export function useModalFocus<Element extends HTMLElement>(input: {
  isOpen: boolean;
  modalRef: RefObject<Element | null>;
  onClose: () => void;
}): void {
  const onClose = useRef(input.onClose);
  onClose.current = input.onClose;
  const { isOpen, modalRef } = input;
  useEffect(() => {
    const modal = modalRef.current;
    if (!isOpen || !modal) return;
    const document = modal.ownerDocument;
    const view = document.defaultView;
    if (!view) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const differentDialogOwnsFocus = () => {
      const active = document.activeElement;
      const dialog = active instanceof HTMLElement ? active.closest('[role="dialog"], dialog') : null;
      return dialog !== null && dialog !== modal;
    };
    const frameId = view.requestAnimationFrame(() => {
      if (!modal.isConnected || (document.activeElement !== opener && differentDialogOwnsFocus())) return;
      (getVisibleFocusTargets(modal)[0] ?? modal).focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (shouldIgnoreGlobalKeyDown(event) || differentDialogOwnsFocus()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose.current();
        return;
      }
      if (event.key !== "Tab") return;
      const targets = getVisibleFocusTargets(modal);
      const first = targets[0];
      const last = targets.at(-1);
      if (!first || !last) {
        event.preventDefault();
        modal.focus();
        return;
      }
      const active = document.activeElement;
      const validFocus = active instanceof HTMLElement && targets.includes(active);
      if (event.shiftKey && (active === first || !validFocus)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !validFocus)) {
        event.preventDefault();
        first.focus();
      }
    };
    view.addEventListener("keydown", handleKeyDown);
    return () => {
      view.cancelAnimationFrame(frameId);
      view.removeEventListener("keydown", handleKeyDown);
      const active = document.activeElement;
      const focusWasOwned = active === document.body || active === document.documentElement ||
        active === null || modal.contains(active);
      if (!focusWasOwned || differentDialogOwnsFocus()) return;
      if (opener?.isConnected && !opener.matches(":disabled") && isVisibleFocusTarget(opener)) opener.focus();
    };
  }, [isOpen, modalRef]);
}
