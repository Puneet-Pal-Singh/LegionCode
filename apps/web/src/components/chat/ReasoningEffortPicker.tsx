import { useEffect, useRef, useState } from "react";
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

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpenKey(null);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

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
      {open ? (
        <div
          role="menu"
          className="ui-surface-popover absolute bottom-full left-0 z-50 mb-2 min-w-44 overflow-hidden p-2"
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
        </div>
      ) : null}
    </div>
  );
}

function formatEffort(value: ReasoningEffortSelection): string {
  if (value === "default") return "Default";
  if (value === "xhigh") return "XHigh";
  return value.charAt(0).toUpperCase() + value.slice(1);
}
