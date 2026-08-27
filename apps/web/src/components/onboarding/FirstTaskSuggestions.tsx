import { ArrowUpRight, FileSearch, Map, Play } from "lucide-react";

interface FirstTaskSuggestionsProps {
  onSubmit: (prompt: string) => void;
  onStartTyping: () => void;
}

const SUGGESTIONS = [
  { label: "Map this codebase", icon: Map },
  { label: "Explain how to run this project", icon: Play },
  { label: "Find the most important TODOs", icon: FileSearch },
] as const;

export function FirstTaskSuggestions({
  onSubmit,
  onStartTyping,
}: FirstTaskSuggestionsProps) {
  return (
    <aside aria-label="First task suggestions" className="mt-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-xs leading-5 text-[#969daa]">
          Work happens in an isolated checkout. Finished changes appear in Review.
        </p>
        <button type="button" onClick={onStartTyping} className="shrink-0 text-xs font-medium text-[#65b8ff] hover:text-white">
          Start typing
        </button>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {SUGGESTIONS.map(({ label, icon: Icon }) => (
          <button key={label} type="button" onClick={() => onSubmit(label)} className="group flex min-h-11 items-center justify-between gap-2 rounded-md border border-[#282c34] bg-[#111318] px-3 text-left text-xs text-[#c7ccd4] transition hover:border-[#4a515d] hover:bg-[#171a20] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#65b8ff]">
            <span className="flex items-center gap-2"><Icon size={14} className="text-[#969daa]" />{label}</span>
            <ArrowUpRight size={13} className="text-[#69717e] transition group-hover:text-[#65b8ff]" />
          </button>
        ))}
      </div>
    </aside>
  );
}
