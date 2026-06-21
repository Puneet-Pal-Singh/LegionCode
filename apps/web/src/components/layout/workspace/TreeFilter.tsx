import { Search } from "lucide-react";

interface TreeFilterProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export function TreeFilter({
  value,
  onChange,
  placeholder = "Filter files...",
}: TreeFilterProps) {
  return (
    <label className="m-3 flex h-9 shrink-0 items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-3 text-zinc-500 focus-within:border-zinc-600">
      <Search size={15} />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-sm text-zinc-200 outline-none placeholder:text-zinc-600"
      />
    </label>
  );
}
