import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { ReasoningEffort } from "@repo/shared-types";
import {
  loadReasoningEffortSelection,
  saveReasoningEffortSelection,
  type ReasoningEffortSelection,
} from "../../lib/model-reasoning-preferences";

interface ReasoningEffortPickerProps {
  providerId: string;
  modelId: string;
  efforts: readonly ReasoningEffort[];
  disabled: boolean;
}

export function ReasoningEffortPicker(props: ReasoningEffortPickerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selectionKey = `${props.providerId}:${props.modelId}`;
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [selection, setSelection] = useState<{
    key: string;
    value: ReasoningEffortSelection;
  } | null>(null);
  const stored = loadReasoningEffortSelection(props.providerId, props.modelId);
  const selected = selection?.key === selectionKey ? selection.value : stored;
  const value =
    selected === "default" || props.efforts.includes(selected)
      ? selected
      : "default";
  const open = openKey === selectionKey;
  const options: ReasoningEffortSelection[] = ["default", ...props.efforts];
  const [menuStyle, setMenuStyle] = useState<{
    bottom: number;
    left: number;
  }>({ bottom: 16, left: 16 });

  const updateMenuPosition = useCallback(() => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(176, window.innerWidth - 32);
    setMenuStyle({
      bottom: Math.max(16, window.innerHeight - rect.top + 8),
      left: Math.min(
        Math.max(16, rect.left),
        Math.max(16, window.innerWidth - width - 16),
      ),
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    updateMenuPosition();
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpenKey(null);
      }
    };
    document.addEventListener("pointerdown", close);
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [open, updateMenuPosition]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label="Reasoning effort"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={props.disabled}
        onClick={() => setOpenKey(open ? null : selectionKey)}
        className="flex h-8 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-zinc-400 transition hover:bg-zinc-800/70 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span>{formatEffort(value)}</span>
        <ChevronDown size={12} className="text-zinc-500" />
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              className="ui-surface-popover fixed z-50 min-w-44 overflow-hidden p-2"
              style={{ bottom: menuStyle.bottom, left: menuStyle.left }}
            >
              {options.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="menuitemradio"
                  aria-checked={value === option}
                  disabled={props.disabled}
                  onClick={() => {
                    setSelection({ key: selectionKey, value: option });
                    saveReasoningEffortSelection(
                      props.providerId,
                      props.modelId,
                      option,
                    );
                    setOpenKey(null);
                  }}
                  className="ui-popover-item justify-between"
                >
                  <span>{formatEffort(option)}</span>
                  {value === option ? (
                    <Check size={14} className="text-zinc-100" />
                  ) : null}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function formatEffort(value: ReasoningEffortSelection): string {
  if (value === "default") return "Default";
  if (value === "xhigh") return "XHigh";
  return value.charAt(0).toUpperCase() + value.slice(1);
}
