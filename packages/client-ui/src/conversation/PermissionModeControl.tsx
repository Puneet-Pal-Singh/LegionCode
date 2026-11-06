import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Hand,
  ShieldAlert,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { PRODUCT_MODES, type ProductMode } from "@repo/shared-types";
import { cn } from "../classnames.js";
import { FullAccessConfirmation } from "./FullAccessConfirmation.js";

interface PermissionModeControlProps {
  value: ProductMode;
  onChange: (mode: ProductMode) => void;
  disabled?: boolean;
  appearance?: "pill" | "ghost";
  showIcon?: boolean;
  menuPlacement?: "above" | "below";
}

interface PermissionModeOption {
  value: ProductMode;
  label: string;
  shortLabel: string;
  description: string;
  Icon: LucideIcon;
}

const PERMISSION_MODE_OPTIONS: PermissionModeOption[] = [
  {
    value: PRODUCT_MODES.ASK_ALWAYS,
    label: "Supervised",
    shortLabel: "Supervised",
    description: "Ask before commands and file changes.",
    Icon: Hand,
  },
  {
    value: PRODUCT_MODES.AUTO_FOR_SAFE,
    label: "Auto-accept edits",
    shortLabel: "Auto edits",
    description: "Auto-approve edits, ask before risky actions.",
    Icon: ShieldCheck,
  },
  {
    value: PRODUCT_MODES.AUTO_FOR_SAME_REPO,
    label: "Auto same repo",
    shortLabel: "Auto repo",
    description: "Auto-run safe actions when they stay inside this repository.",
    Icon: ShieldCheck,
  },
  {
    value: PRODUCT_MODES.FULL_AGENT,
    label: "Full access",
    shortLabel: "Full access",
    description: "Broader control of this hosted workspace.",
    Icon: ShieldAlert,
  },
];

export function PermissionModeControl({
  value,
  onChange,
  disabled = false,
  appearance = "pill",
  showIcon = true,
  menuPlacement = "above",
}: PermissionModeControlProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isConfirmationOpen, setIsConfirmationOpen] = useState(false);
  const [modeAtConfirmationOpen, setModeAtConfirmationOpen] =
    useState<ProductMode | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const controlButtonRef = useRef<HTMLButtonElement>(null);
  const wasConfirmationVisibleRef = useRef(false);
  const selectedOption = resolvePermissionModeOption(value);
  const SelectedIcon = selectedOption.Icon;
  const isMenuOpen = isOpen && !disabled;
  const isFullAccess = selectedOption.value === PRODUCT_MODES.FULL_AGENT;
  const isConfirmationVisible = isConfirmationOpen && !disabled;
  const [menuStyle, setMenuStyle] = useState<{
    top: number | null;
    bottom: number | null;
    left: number;
  }>({ top: null, bottom: 16, left: 16 });

  const updateMenuPosition = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(304, window.innerWidth - 32);
    const left = Math.min(
      Math.max(16, rect.left),
      Math.max(16, window.innerWidth - width - 16),
    );
    setMenuStyle(
      menuPlacement === "below"
        ? { top: rect.bottom + 8, bottom: null, left }
        : {
            top: null,
            bottom: Math.max(16, window.innerHeight - rect.top + 8),
            left,
          },
    );
  }, [menuPlacement]);

  useEffect(() => {
    const frame = isMenuOpen
      ? requestAnimationFrame(updateMenuPosition)
      : undefined;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !containerRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      document.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [isMenuOpen, updateMenuPosition]);

  useEffect(() => {
    if (
      !isConfirmationVisible &&
      wasConfirmationVisibleRef.current &&
      !disabled
    ) {
      controlButtonRef.current?.focus();
    }
    wasConfirmationVisibleRef.current = isConfirmationVisible;
  }, [isConfirmationVisible, disabled]);

  useEffect(() => {
    if (disabled && isConfirmationOpen) {
      setIsConfirmationOpen(false);
      setModeAtConfirmationOpen(null);
    }
  }, [disabled, isConfirmationOpen]);

  const closeConfirmation = () => {
    setIsConfirmationOpen(false);
    setModeAtConfirmationOpen(null);
  };

  const confirmFullAccess = () => {
    if (
      disabled ||
      modeAtConfirmationOpen === null ||
      modeAtConfirmationOpen !== value
    ) {
      closeConfirmation();
      return;
    }
    closeConfirmation();
    onChange(PRODUCT_MODES.FULL_AGENT);
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={controlButtonRef}
        type="button"
        onClick={() => {
          if (disabled) {
            return;
          }
          setIsOpen((current) => !current);
        }}
        disabled={disabled}
        className={cn(
          appearance === "ghost"
            ? "inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-zinc-400 transition-all duration-200 hover:bg-zinc-800/50 hover:text-zinc-100"
            : "inline-flex items-center gap-1.5 rounded-full border border-zinc-700/70 bg-zinc-900/80 px-2.5 py-1 text-xs font-medium text-zinc-300 transition",
          appearance === "pill" &&
            "hover:border-zinc-500/70 hover:bg-zinc-800/70 hover:text-zinc-100",
          appearance === "ghost" &&
            isFullAccess &&
            "text-orange-400 hover:text-orange-300",
          disabled && "cursor-not-allowed opacity-45 hover:border-zinc-700/70",
        )}
        aria-haspopup="menu"
        aria-expanded={isMenuOpen}
        aria-label="Permission mode"
        data-testid="permission-mode-control"
      >
        {showIcon ? (
          <SelectedIcon
            size={14}
            className={cn(isFullAccess ? "text-orange-400" : "text-zinc-400")}
          />
        ) : null}
        <span>{selectedOption.shortLabel}</span>
        <ChevronDown
          size={14}
          className={cn(
            "text-zinc-400 transition-transform",
            appearance === "ghost" && isFullAccess && "text-orange-400",
            isMenuOpen && "rotate-180",
          )}
        />
      </button>

      {isMenuOpen && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              className="ui-surface-popover fixed z-50 w-[19rem] p-1.5"
              style={{
                top: menuStyle.top ?? undefined,
                bottom: menuStyle.bottom ?? undefined,
                left: menuStyle.left,
              }}
              data-testid="permission-mode-menu"
            >
              {PERMISSION_MODE_OPTIONS.map((option) => {
                const OptionIcon = option.Icon;
                const isSelected = option.value === selectedOption.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={isSelected}
                    onClick={() => {
                      if (disabled) {
                        return;
                      }
                      setIsOpen(false);
                      if (option.value === PRODUCT_MODES.FULL_AGENT) {
                        setModeAtConfirmationOpen(value);
                        setIsConfirmationOpen(true);
                        return;
                      }
                      onChange(option.value);
                    }}
                    disabled={disabled}
                    className={cn(
                      "flex min-h-12 w-full items-start justify-between rounded-md px-2.5 py-2 text-left transition",
                      isSelected
                        ? "bg-zinc-800/70 text-zinc-100"
                        : "text-zinc-200 hover:bg-zinc-800/50",
                    )}
                  >
                    <span className="flex items-start gap-2.5">
                      <OptionIcon
                        size={15}
                        className="mt-0.5 shrink-0 text-zinc-400"
                      />
                      <span className="space-y-0.5">
                        <span className="block text-sm font-medium">
                          {option.label}
                        </span>
                        <span className="block text-xs leading-4 text-zinc-400">
                          {option.description}
                        </span>
                      </span>
                    </span>
                    {isSelected ? (
                      <Check
                        size={15}
                        className="mt-0.5 shrink-0 text-zinc-100"
                      />
                    ) : null}
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}

      {isConfirmationVisible ? (
        <FullAccessConfirmation
          onCancel={closeConfirmation}
          onConfirm={confirmFullAccess}
        />
      ) : null}
    </div>
  );
}

function resolvePermissionModeOption(value: ProductMode): PermissionModeOption {
  const option = PERMISSION_MODE_OPTIONS.find((entry) => entry.value === value);
  if (option) {
    return option;
  }

  throw new Error(
    `[permission-mode-control] Unsupported mode "${value}" received.`,
  );
}
