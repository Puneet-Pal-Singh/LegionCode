import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";

export function ThreadSidebarSectionHeader({ label, expanded, onToggle, children }: {
  label: string;
  expanded: boolean;
  onToggle: () => void;
  children?: ReactNode;
}): React.ReactElement {
  return (
    <div className="flex h-8 items-center justify-between px-2">
      <button type="button" aria-label={`Toggle ${label}`} aria-expanded={expanded} onClick={onToggle} className="group/section flex min-w-0 flex-1 items-center gap-1 text-left text-sm font-medium text-zinc-500 transition hover:text-zinc-300">
        <span>{label}</span>
        <ChevronDown size={13} aria-hidden="true" className={`transition-transform ${expanded ? "" : "-rotate-90"}`} />
      </button>
      <div className="flex items-center gap-1">{children}</div>
    </div>
  );
}
