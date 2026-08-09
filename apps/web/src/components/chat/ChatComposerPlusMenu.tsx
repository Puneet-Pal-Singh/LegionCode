import { useEffect, useRef, useState } from "react";
import type { RunMode } from "@repo/shared-types";
import { motion } from "framer-motion";
import { Paperclip, Plus, Sparkles } from "lucide-react";

interface ChatComposerPlusMenuProps {
  mode: RunMode;
  disabled?: boolean;
  onAddFiles: () => void;
  onModeChange?: (mode: RunMode) => void;
}

export function ChatComposerPlusMenu({
  mode,
  disabled = false,
  onAddFiles,
  onModeChange,
}: ChatComposerPlusMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const isMenuOpen = isOpen && !disabled;

  useEffect(() => {
    if (!isMenuOpen) {
      return;
    }

    const handleOutsideClick = (event: MouseEvent): void => {
      if (!containerRef.current) {
        return;
      }
      if (!containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    window.addEventListener("mousedown", handleOutsideClick);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("mousedown", handleOutsideClick);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [isMenuOpen]);

  const isPlanMode = mode === "plan";

  return (
    <div className="relative" ref={containerRef}>
      <motion.button
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

      {isMenuOpen ? (
        <div
          role="menu"
          className="ui-surface-popover absolute bottom-full left-0 z-40 mb-2 w-64 p-2"
        >
          <button
            type="button"
            role="menuitem"
            disabled={disabled}
            onClick={() => {
              if (disabled) {
                return;
              }
              onAddFiles();
              setIsOpen(false);
            }}
            className="ui-popover-item gap-3 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-zinc-200"
          >
            <Paperclip size={16} className="text-zinc-400" />
            Add photos & files
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
              disabled={disabled || !onModeChange}
              onClick={() => {
                if (!onModeChange || disabled) {
                  return;
                }
                onModeChange(isPlanMode ? "build" : "plan");
              }}
              className={[
                "relative inline-flex h-7 w-12 items-center rounded-full border transition-colors",
                isPlanMode
                  ? "border-emerald-500/70 bg-emerald-500/20"
                  : "border-zinc-700 bg-zinc-800/80",
                disabled || !onModeChange
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
        </div>
      ) : null}
    </div>
  );
}
