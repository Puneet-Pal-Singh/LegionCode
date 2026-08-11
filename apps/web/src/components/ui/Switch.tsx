import { cn } from "../../lib/utils";

export function Switch({
  checked,
  onCheckedChange,
  disabled = false,
  label,
  className,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
  className?: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-200",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950",
        checked
          ? "border-blue-500 bg-blue-500"
          : "border-zinc-600 bg-zinc-800 hover:border-zinc-500",
        "disabled:cursor-not-allowed disabled:opacity-40",
        className,
      )}
    >
      <span
        className={cn(
          "block size-4 rounded-full bg-white shadow-sm transition-transform duration-200",
          checked
            ? "translate-x-[17px]"
            : "translate-x-0.5",
        )}
      />
    </button>
  );
}
