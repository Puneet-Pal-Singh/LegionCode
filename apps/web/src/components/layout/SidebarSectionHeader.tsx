import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

export function SidebarSectionHeader(props: {
  label: string;
  expanded: boolean;
  onToggle: () => void;
  controlsId: string;
  children: ReactNode;
}) {
  return (
    <div className="group/projects flex h-8 items-center justify-between px-2">
      <button
        type="button"
        aria-expanded={props.expanded}
        aria-controls={props.controlsId}
        onClick={props.onToggle}
        className="flex items-center gap-1.5 rounded py-1 text-sm font-medium text-zinc-500 hover:text-zinc-300"
      >
        {props.label}
        <ChevronDown
          size={14}
          className={`transition-transform ${props.expanded ? "" : "-rotate-90"}`}
        />
      </button>
      <div className="flex items-center gap-1">{props.children}</div>
    </div>
  );
}
