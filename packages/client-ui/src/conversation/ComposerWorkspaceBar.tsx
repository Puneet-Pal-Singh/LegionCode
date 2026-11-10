import { Check, ChevronDown, Cloud, Folder, Monitor, type LucideIcon } from "lucide-react";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { shouldIgnoreGlobalKeyDown } from "../hooks/global-keydown.js";
import { useOutsideDismiss } from "../hooks/useOutsideDismiss.js";
import { useViewportPopoverPosition } from "../hooks/useViewportPopoverPosition.js";

type Placement = "local" | "cloud";
type WorkspaceChip = {
  label: string;
  onOpen?: () => void | Promise<void>;
  unavailableReason?: string;
};

export interface ComposerWorkspaceBarProps {
  /** Current host-owned workspace/grant/Thread scope; not execution authority. */
  scopeKey: string;
  project: WorkspaceChip;
  /** Hosts may retain an existing picker around the actual project trigger. */
  renderProjectTrigger?: (trigger: ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>) => ReactNode;
  placement: Placement;
  placementOptions: readonly { value: Placement; unavailableReason?: string }[];
  onPlacementChange?: (placement: Placement) => void | Promise<void>;
  cloudEnvironment?: WorkspaceChip;
  disabledReason?: string;
}

const PLACEMENT_LABELS: Record<Placement, string> = {
  local: "This computer",
  cloud: "Cloud",
};
const CHIP_CLASS = "ui-control-surface inline-flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-lg px-2.5 text-[13px] text-zinc-300 transition hover:bg-zinc-800/70 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500 disabled:cursor-not-allowed disabled:opacity-50";

/** Shared presentation only. Hosts own selection, command delivery and error notices. */
export function ComposerWorkspaceBar(props: ComposerWorkspaceBarProps): React.JSX.Element {
  const { scopeKey, project, placement, placementOptions, cloudEnvironment, disabledReason } = props;
  const latest = useRef(props);
  latest.current = props;
  const [openScope, setOpenScope] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const placementReasonId = useId();
  const isOpen = openScope === scopeKey && !disabledReason;
  const closeMenu = useCallback(() => setOpenScope(null), []);
  const insideRefs = useMemo(() => [panelRef], []);
  const menuStyle = useViewportPopoverPosition(isOpen, triggerRef, panelRef, {
    align: "auto", placement: "auto", preferredWidth: 248,
  });
  useOutsideDismiss(rootRef, isOpen, closeMenu, {
    additionalRefs: insideRefs,
    escapeFocusRef: triggerRef,
  });
  useEffect(closeMenu, [closeMenu, scopeKey, placement, disabledReason]);

  useEffect(() => {
    if (!isOpen || menuStyle.visibility !== "visible") return;
    const panel = panelRef.current;
    const selected = panel?.querySelector<HTMLButtonElement>('[aria-checked="true"]:not(:disabled)');
    const first = panel?.querySelector<HTMLButtonElement>('button:not(:disabled)');
    (selected ?? first ?? panel)?.focus({ preventScroll: true });
  }, [isOpen, menuStyle.visibility]);

  const closeAndRestoreFocus = () => {
    closeMenu();
    if (latest.current.scopeKey === scopeKey && !triggerRef.current?.disabled)
      triggerRef.current?.focus({ preventScroll: true });
  };
  const openChip = (kind: "project" | "cloudEnvironment") => {
    const current = latest.current;
    const chip = current[kind];
    if (current.scopeKey !== scopeKey || current.disabledReason || chip?.unavailableReason || !chip?.onOpen) return;
    closeMenu();
    void chip.onOpen();
  };
  const selectPlacement = (value: Placement) => {
    const current = latest.current;
    const option = current.placementOptions.find((item) => item.value === value);
    if (current.scopeKey !== scopeKey || current.disabledReason || !option || option.unavailableReason) return;
    if (value !== current.placement && !current.onPlacementChange) return;
    closeAndRestoreFocus();
    if (value !== current.placement) void current.onPlacementChange?.(value);
  };
  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (shouldIgnoreGlobalKeyDown(event.nativeEvent)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeAndRestoreFocus();
      return;
    }
    if (event.key === "Tab") {
      closeAndRestoreFocus();
      return;
    }
    const items = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    if (items.length === 0) return;
    const index = items.findIndex((item) => item === document.activeElement);
    const next = event.key === "ArrowDown" ? (index + 1) % items.length
      : event.key === "ArrowUp" ? (index <= 0 ? items.length : index) - 1
      : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    items[next]?.focus({ preventScroll: true });
  };
  const projectReason = disabledReason ?? project.unavailableReason ??
    (!project.onOpen && !props.renderProjectTrigger ? "Project selection is unavailable in this session." : undefined);
  const cloudReason = disabledReason ?? cloudEnvironment?.unavailableReason ??
    (!cloudEnvironment?.onOpen ? "Cloud environment selection is unavailable in this session." : undefined);
  const placementReason = disabledReason ??
    (placementOptions.length === 0 ? "Execution locations are unavailable in this session." : undefined);
  const PlacementIcon = placement === "local" ? Monitor : Cloud;

  return (
    <div ref={rootRef} role="group" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5" aria-label="Workspace and execution location">
      <WorkspaceChipButton icon={Folder} label={project.label} actionLabel="Choose project" reason={projectReason}
        renderTrigger={props.renderProjectTrigger}
        onClick={props.renderProjectTrigger ? closeMenu : () => openChip("project")} />
      {placementReason ? <span id={placementReasonId} className="sr-only">{placementReason}</span> : null}
      <button
        ref={triggerRef}
        type="button"
        className={CHIP_CLASS}
        disabled={Boolean(placementReason)}
        title={placementReason ?? `Work in ${PLACEMENT_LABELS[placement]}`}
        aria-label={`Work in ${PLACEMENT_LABELS[placement]}`}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={isOpen ? menuId : undefined}
        aria-describedby={placementReason ? placementReasonId : undefined}
        onClick={() => setOpenScope(isOpen ? null : scopeKey)}
        onKeyDown={(event) => {
          if (shouldIgnoreGlobalKeyDown(event.nativeEvent)) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpenScope(scopeKey);
          }
        }}
      >
        <span className="text-zinc-500">Work in</span>
        <PlacementIcon size={14} className="shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">{PLACEMENT_LABELS[placement]}</span>
        <ChevronDown size={13} className="shrink-0 text-zinc-500" aria-hidden="true" />
      </button>
      {placement === "cloud" && cloudEnvironment ? (
        <WorkspaceChipButton icon={Cloud} label={cloudEnvironment.label} actionLabel="Choose cloud environment" reason={cloudReason} onClick={() => openChip("cloudEnvironment")} />
      ) : null}
      {isOpen && typeof document !== "undefined" ? createPortal(
        <div ref={panelRef} id={menuId} role="menu" aria-label="Work in" tabIndex={-1}
          className="ui-surface-popover fixed z-50 overflow-y-auto p-1.5" style={menuStyle} onKeyDown={handleMenuKeyDown}>
          {placementOptions.map((option) => {
            const selected = option.value === placement;
            const reason = option.unavailableReason ??
              (!selected && !props.onPlacementChange ? "This location is unavailable in this session." : undefined);
            const Icon = option.value === "local" ? Monitor : Cloud;
            return (
              <button key={option.value} type="button" role="menuitemradio" aria-checked={selected}
                disabled={Boolean(reason)} title={reason}
                onClick={() => selectPlacement(option.value)}
                className="ui-popover-item min-h-10 gap-2 disabled:cursor-not-allowed disabled:opacity-50">
                <Icon size={15} className="shrink-0 text-zinc-400" aria-hidden="true" />
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate">{PLACEMENT_LABELS[option.value]}</span>
                  {reason ? <span className="mt-0.5 block text-xs leading-4 text-zinc-500">{reason}</span> : null}
                </span>
                {selected ? <Check size={15} className="shrink-0 text-zinc-300" aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>, document.body,
      ) : null}
    </div>
  );
}

function WorkspaceChipButton({ icon: Icon, label, actionLabel, reason, onClick, renderTrigger }: {
  icon: LucideIcon;
  label: string;
  actionLabel: string;
  reason: string | undefined;
  onClick?: () => void;
  renderTrigger?: ComposerWorkspaceBarProps["renderProjectTrigger"];
}): React.JSX.Element {
  const reasonId = useId();
  const trigger = (
    <button type="button" className={CHIP_CLASS} disabled={Boolean(reason)} title={reason ?? label}
      aria-label={`${actionLabel}: ${label}`} aria-describedby={reason ? reasonId : undefined} onClick={onClick}>
      <Icon size={14} className="shrink-0 text-zinc-400" aria-hidden="true" />
      <span className="min-w-0 max-w-64 truncate">{label}</span>
      <ChevronDown size={13} className="shrink-0 text-zinc-500" aria-hidden="true" />
    </button>
  );
  return (
    <>
      {reason ? <span id={reasonId} className="sr-only">{reason}</span> : null}
      {renderTrigger ? renderTrigger(trigger) : trigger}
    </>
  );
}
