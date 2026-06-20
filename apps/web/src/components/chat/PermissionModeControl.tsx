import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Hand,
  ShieldAlert,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { PRODUCT_MODES, type ProductMode } from "@repo/shared-types";
import { cn } from "../../lib/utils";

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
    description: "Allow commands and edits without prompts.",
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
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedOption = resolvePermissionModeOption(value);
  const SelectedIcon = selectedOption.Icon;
  const isMenuOpen = isOpen && !disabled;
  const isFullAccess = selectedOption.value === PRODUCT_MODES.FULL_AGENT;

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <button
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
            ? "inline-flex items-center gap-2 rounded-md px-2 py-1 text-xs font-medium transition-all duration-200 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/50"
            : "inline-flex items-center gap-1.5 rounded-full border border-zinc-700/70 bg-zinc-900/80 px-2.5 py-1 text-xs font-medium text-zinc-300 transition",
          appearance === "pill" &&
            "hover:border-zinc-500/70 hover:bg-zinc-800/70 hover:text-zinc-100",
          appearance === "ghost" &&
            isFullAccess &&
            "text-orange-400 hover:text-orange-300",
          disabled && "cursor-not-allowed opacity-60 hover:border-zinc-700/70",
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

      {isMenuOpen ? (
        <div
          role="menu"
          className={cn(
            "ui-surface-popover absolute left-0 z-40 w-[19rem] p-2",
            menuPlacement === "below" ? "top-full mt-2" : "bottom-full mb-2",
          )}
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
                  onChange(option.value);
                  setIsOpen(false);
                }}
                disabled={disabled}
                className={cn(
                  "flex w-full items-start justify-between rounded-2xl px-3 py-2 text-left transition",
                  isSelected
                    ? "bg-zinc-800/70 text-zinc-100"
                    : "text-zinc-200 hover:bg-zinc-800/50",
                )}
              >
                <span className="flex items-start gap-2.5">
                  <OptionIcon
                    size={16}
                    className="mt-0.5 shrink-0 text-zinc-400"
                  />
                  <span className="space-y-0.5">
                    <span className="block text-sm font-medium">
                      {option.label}
                    </span>
                    <span className="block text-xs text-zinc-400">
                      {option.description}
                    </span>
                  </span>
                </span>
                {isSelected ? (
                  <Check size={17} className="mt-0.5 shrink-0 text-zinc-100" />
                ) : null}
              </button>
            );
          })}
        </div>
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
