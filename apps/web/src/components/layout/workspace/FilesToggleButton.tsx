import { Folders } from "lucide-react";
import { cn } from "../../../lib/utils";

interface FilesToggleButtonProps {
  isOpen: boolean;
  onToggle: () => void;
}

export function FilesToggleButton({
  isOpen,
  onToggle,
}: FilesToggleButtonProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        "rounded-lg p-2 transition-colors hover:bg-zinc-800 hover:text-white",
        isOpen ? "bg-zinc-800 text-white" : "bg-zinc-900 text-zinc-300",
      )}
      aria-label="Toggle files sidebar"
      aria-pressed={isOpen}
      title={isOpen ? "Hide files" : "Show files"}
    >
      <Folders size={19} />
    </button>
  );
}
