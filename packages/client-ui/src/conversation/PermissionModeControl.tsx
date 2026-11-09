import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useOutsideDismiss } from "../hooks/useOutsideDismiss.js";
import { useViewportPopoverPosition } from "../hooks/useViewportPopoverPosition.js";

interface PermissionModeControlProps {
  value: ProductMode;
  availableModes?: readonly ProductMode[];
  environmentKind?: "hosted" | "local";
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
  availableModes,
  environmentKind = "hosted",
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
  const fullAccessAvailable = !availableModes || availableModes.includes(PRODUCT_MODES.FULL_AGENT);
  const isConfirmationVisible = isConfirmationOpen && !disabled && fullAccessAvailable;
  const menuStyle = useViewportPopoverPosition(
    isMenuOpen,
    controlButtonRef,
    menuRef,
    { align: "start", placement: menuPlacement, viewportPadding: 16 },
  );
  const closeMenu = useCallback(() => setIsOpen(false), []);
  const dismissRefs = useMemo(() => [menuRef], []);
  useOutsideDismiss(containerRef, isMenuOpen, closeMenu, {
    additionalRefs: dismissRefs,
    escapeFocusRef: controlButtonRef,
  });

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
    if ((disabled || !fullAccessAvailable) && isConfirmationOpen) {
      setIsConfirmationOpen(false);
      setModeAtConfirmationOpen(null);
    }
  }, [disabled, fullAccessAvailable, isConfirmationOpen]);

  const closeConfirmation = () => {
    setIsConfirmationOpen(false);
    setModeAtConfirmationOpen(null);
  };

  const confirmFullAccess = () => {
    if (
      disabled ||
      !fullAccessAvailable ||
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
              className="ui-surface-popover fixed z-50 w-[19rem] max-w-[calc(100vw-32px)] overflow-y-auto p-1.5"
              style={menuStyle}
              data-testid="permission-mode-menu"
            >
              {PERMISSION_MODE_OPTIONS.map((option) => {
                const OptionIcon = option.Icon;
                const isSelected = option.value === selectedOption.value;
                const available = !availableModes || availableModes.includes(option.value);
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={isSelected}
                    onClick={() => {
                      if (disabled || !available) {
                        return;
                      }
                      setIsOpen(false);
                      if (option.value === PRODUCT_MODES.FULL_AGENT) {
                        setModeAtConfirmationOpen(value);
                        setIsConfirmationOpen(true);
                        return;
                      }
                      onChange(option.value);
                      if (!controlButtonRef.current?.disabled) {
                        controlButtonRef.current?.focus();
                      }
                    }}
                    disabled={disabled || !available}
                    title={available ? undefined : "Unavailable in this environment"}
                    className={cn(
                      "flex min-h-12 w-full items-start justify-between rounded-md px-2.5 py-2 text-left transition disabled:cursor-not-allowed disabled:opacity-50",
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
                          {option.value === PRODUCT_MODES.FULL_AGENT && environmentKind === "local" ? "Run local tools without individual approvals." : option.description}
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
          environmentKind={environmentKind}
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
