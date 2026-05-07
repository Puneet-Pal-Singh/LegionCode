import { Check, ChevronDown } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/utils";
import type { ReviewScope } from "./GitReviewContext";

interface ReviewScopeDropdownProps {
  value: ReviewScope;
  onChange: (scope: ReviewScope) => void;
  className?: string;
}

const REVIEW_SCOPE_OPTIONS: Array<{
  value: ReviewScope | "branch-changes" | "last-turn-changes";
  label: string;
  disabled: boolean;
}> = [
  { value: "git-changes", label: "Git changes", disabled: false },
  { value: "branch-changes", label: "Branch changes", disabled: true },
  { value: "last-turn-changes", label: "Last turn changes", disabled: true },
];

const DEFAULT_REVIEW_SCOPE_OPTION = REVIEW_SCOPE_OPTIONS[0] as {
  value: ReviewScope;
  label: string;
  disabled: false;
};

export function ReviewScopeDropdown({
  value,
  onChange,
  className,
}: ReviewScopeDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const selectedOption =
    REVIEW_SCOPE_OPTIONS.find((option) => option.value === value) ??
    DEFAULT_REVIEW_SCOPE_OPTION;

  return (
    <div className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setIsOpen((previous) => !previous)}
        className="inline-flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-700 hover:bg-zinc-800"
        aria-haspopup="menu"
        aria-expanded={isOpen}
      >
        {selectedOption.label}
        <ChevronDown
          size={14}
          className={cn("text-zinc-500 transition-transform", isOpen && "rotate-180")}
        />
      </button>

      {isOpen ? (
        <>
          <button
            type="button"
            className="fixed inset-0 z-20 cursor-default"
            aria-label="Close review scope menu"
            onClick={() => setIsOpen(false)}
          />
          <div
            role="menu"
            className="absolute left-0 top-full z-30 mt-1 min-w-52 rounded-lg border border-zinc-800 bg-zinc-950 p-1.5 shadow-2xl"
          >
            {REVIEW_SCOPE_OPTIONS.map((option) => {
              const isSelected = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="menuitem"
                  disabled={option.disabled}
                  onClick={() => {
                    if (!option.disabled) {
                      onChange(option.value as ReviewScope);
                      setIsOpen(false);
                    }
                  }}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors",
                    isSelected
                      ? "bg-zinc-800 text-white"
                      : "text-zinc-300 hover:bg-zinc-900 hover:text-white",
                    option.disabled &&
                      "cursor-not-allowed text-zinc-600 hover:bg-transparent hover:text-zinc-600",
                  )}
                >
                  <span>{option.label}</span>
                  {option.disabled ? (
                    <span className="text-[10px] uppercase tracking-wide text-zinc-600">
                      Coming soon
                    </span>
                  ) : isSelected ? (
                    <Check size={14} className="text-zinc-300" />
                  ) : null}
                </button>
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}
