import { useEffect, useRef, useState } from "react";
import { BrainCircuit, Check, ChevronDown } from "lucide-react";
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
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<ReasoningEffortSelection>(() =>
    loadReasoningEffortSelection(props.providerId, props.modelId),
  );
  const options: ReasoningEffortSelection[] = ["default", ...props.efforts];

  useEffect(() => {
    const stored = loadReasoningEffortSelection(
      props.providerId,
      props.modelId,
    );
    setValue(
      stored === "default" || props.efforts.includes(stored)
        ? stored
        : "default",
    );
    setOpen(false);
  }, [props.efforts, props.modelId, props.providerId]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
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
        onClick={() => setOpen((current) => !current)}
        className="flex h-8 items-center gap-1.5 rounded-lg border border-zinc-700/80 bg-zinc-900/80 px-2.5 text-xs font-medium text-zinc-300 transition hover:border-zinc-600 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <BrainCircuit size={13} className="text-amber-300/90" />
        <span>{formatEffort(value)}</span>
        <ChevronDown size={12} className="text-zinc-500" />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute bottom-full left-0 z-50 mb-2 min-w-44 overflow-hidden rounded-xl border border-zinc-700/80 bg-zinc-950 p-1.5 shadow-2xl shadow-black/60"
        >
          <div className="px-2 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
            Reasoning effort
          </div>
          {options.map((option) => (
            <button
              key={option}
              type="button"
              role="menuitemradio"
              aria-checked={value === option}
              onClick={() => {
                setValue(option);
                saveReasoningEffortSelection(
                  props.providerId,
                  props.modelId,
                  option,
                );
                setOpen(false);
              }}
              className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-sm text-zinc-200 transition hover:bg-zinc-800"
            >
              <span>{formatEffort(option)}</span>
              {value === option ? (
                <Check size={14} className="text-amber-300" />
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function formatEffort(value: ReasoningEffortSelection): string {
  if (value === "xhigh") return "XHigh";
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
