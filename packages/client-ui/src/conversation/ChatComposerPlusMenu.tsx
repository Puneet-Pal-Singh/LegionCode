import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import type { RunMode } from "@repo/shared-types";
import { motion } from "framer-motion";
import { FileCode2, ImagePlus, Plus, Sparkles } from "lucide-react";
import { useViewportPopoverPosition } from "../workspace/EnvironmentSummaryMenu.js";

interface ChatComposerPlusMenuProps {
  mode: RunMode;
  availableModes?: readonly RunMode[];
  disabled?: boolean;
  attachmentsAvailable?: boolean;
  onAttachImages: () => void;
  onAddRepositoryContext: () => void;
  onModeChange?: (mode: RunMode) => void;
}

export function ChatComposerPlusMenu({
  mode,
  availableModes,
  disabled = false,
  attachmentsAvailable = true,
  onAttachImages,
  onAddRepositoryContext,
  onModeChange,
}: ChatComposerPlusMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const isMenuOpen = isOpen && !disabled;
  useEffect(() => {
    if (disabled) setIsOpen(false);
  }, [disabled]);
  const menuStyle = useViewportPopoverPosition(
    isMenuOpen,
    containerRef,
    menuRef,
    {
      align: "start",
      placement: "above",
    },
  );

  useEffect(() => {
    if (!isMenuOpen) {
      return;
    }

    const handleOutsideClick = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (
        !containerRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setIsOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    };

    window.addEventListener("mousedown", handleOutsideClick);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("mousedown", handleOutsideClick);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [isMenuOpen]);

  useEffect(() => {
    if (isMenuOpen && menuStyle.visibility === "visible")
      menuRef.current
        ?.querySelector<HTMLButtonElement>("button:not([disabled])")
        ?.focus();
  }, [isMenuOpen, menuStyle.visibility]);

  const handleMenuKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ): void => {
    const buttons = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        "button:not([disabled])",
      ) ?? [],
    );
    if (buttons.length === 0) return;
    const index = buttons.findIndex(
      (button) => button === document.activeElement,
    );
    if (event.key === "Tab") {
      if (
        (event.shiftKey && index === 0) ||
        (!event.shiftKey && index === buttons.length - 1)
      ) {
        setIsOpen(false);
        triggerRef.current?.focus();
        if (event.shiftKey) event.preventDefault();
      }
      return;
    }
    const next =
      event.key === "ArrowDown"
        ? (index + 1) % buttons.length
        : event.key === "ArrowUp"
          ? index <= 0
            ? buttons.length - 1
            : index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : null;
    if (next !== null) {
      event.preventDefault();
      buttons[next]?.focus();
    }
  };

  const isPlanMode = mode === "plan";
  const canToggleMode =
    !disabled &&
    Boolean(onModeChange) &&
    (!availableModes || availableModes.includes(isPlanMode ? "build" : "plan"));

  return (
    <div className="relative" ref={containerRef}>
      <motion.button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setIsOpen((current) => !current)}
        whileHover={{ scale: disabled ? 1 : 1.1 }}
        whileTap={{ scale: disabled ? 1 : 0.9 }}
        className="p-1 text-zinc-500 transition-colors hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-60"
        title="More composer options"
        aria-label="Open composer options"
        aria-expanded={isMenuOpen}
        aria-haspopup="menu"
      >
        <Plus size={16} />
      </motion.button>

      {isMenuOpen && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              className="ui-surface-popover fixed z-50 w-64 overflow-y-auto p-2"
              style={{ ...menuStyle, maxWidth: "calc(100vw - 16px)" }}
              onKeyDown={handleMenuKeyDown}
            >
              <button
                type="button"
                role="menuitem"
                disabled={disabled || !attachmentsAvailable}
                title={
                  attachmentsAvailable
                    ? undefined
                    : "Image attachments are unavailable in this environment"
                }
                onClick={() => {
                  if (disabled || !attachmentsAvailable) {
                    return;
                  }
                  onAttachImages();
                  setIsOpen(false);
                }}
                className="ui-popover-item gap-3 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-zinc-200"
              >
                <ImagePlus size={16} className="text-zinc-400" />
                Attach images
              </button>

              <button
                type="button"
                role="menuitem"
                disabled={disabled}
                onClick={() => {
                  if (disabled) return;
                  onAddRepositoryContext();
                  setIsOpen(false);
                }}
                className="ui-popover-item gap-3 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-zinc-200"
              >
                <FileCode2 size={16} className="text-zinc-400" />
                Add repository context
              </button>

              <div className="my-2 h-px bg-zinc-800" />

              <div className="flex min-h-10 items-center justify-between gap-2 rounded-md px-3 py-2">
                <div className="flex items-center gap-3 text-sm text-zinc-200">
                  <Sparkles size={16} className="text-zinc-400" />
                  <span>Plan mode</span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={isPlanMode}
                  aria-label="Toggle plan mode"
                  disabled={!canToggleMode}
                  onClick={() => {
                    if (!onModeChange || !canToggleMode) {
                      return;
                    }
                    onModeChange(isPlanMode ? "build" : "plan");
                  }}
                  className={[
                    "relative inline-flex h-7 w-12 items-center rounded-full border transition-colors",
                    isPlanMode
                      ? "border-emerald-500/70 bg-emerald-500/20"
                      : "border-zinc-700 bg-zinc-800/80",
                    !canToggleMode
                      ? "cursor-not-allowed opacity-60"
                      : "hover:border-zinc-500/90",
                  ].join(" ")}
                >
                  <span
                    className={[
                      "inline-block h-5 w-5 transform rounded-full bg-zinc-100 transition",
                      isPlanMode ? "translate-x-6" : "translate-x-1",
                    ].join(" ")}
                  />
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
