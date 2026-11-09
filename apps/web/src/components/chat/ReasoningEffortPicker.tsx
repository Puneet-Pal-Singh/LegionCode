import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { ReasoningEffort } from "@repo/shared-types";
import { useOutsideDismiss, useViewportPopoverPosition } from "@legioncode/client-ui";
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
  const triggerRef = useRef<HTMLButtonElement>(null);
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
  const open = openKey === selectionKey && !props.disabled;
  const options: ReasoningEffortSelection[] = ["default", ...props.efforts];
  const menuStyle = useViewportPopoverPosition(
    open,
    triggerRef,
    menuRef,
    { align: "start", placement: "above", viewportPadding: 16 },
  );
  const close = useCallback(() => setOpenKey(null), []);
  const dismissRefs = useMemo(() => [menuRef], []);
  useOutsideDismiss(rootRef, open, close, {
    additionalRefs: dismissRefs,
    escapeFocusRef: triggerRef,
  });

  useEffect(() => {
    if (!props.disabled) return;
    const frame = requestAnimationFrame(() => setOpenKey(null));
    return () => cancelAnimationFrame(frame);
  }, [props.disabled]);

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
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
              className="ui-surface-popover fixed z-50 min-w-44 max-w-[calc(100vw-32px)] overflow-y-auto p-2"
              style={menuStyle}
            >
              {options.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="menuitemradio"
                  aria-checked={value === option}
                  disabled={props.disabled}
                  onClick={() => {
                    if (props.disabled) return;
                    setSelection({ key: selectionKey, value: option });
                    saveReasoningEffortSelection(
                      props.providerId,
                      props.modelId,
                      option,
                    );
                    setOpenKey(null);
                    if (!triggerRef.current?.disabled) triggerRef.current?.focus();
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
