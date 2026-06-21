import { File, GitBranch } from "lucide-react";

export function FileChangesIcon({ size = 16 }: { size?: number }) {
  return (
    <span
      className="relative inline-flex shrink-0"
      style={{ height: size, width: size }}
      aria-hidden="true"
    >
      <File size={size} />
      <GitBranch
        size={Math.max(8, Math.round(size / 2))}
        strokeWidth={3}
        className="absolute -bottom-0.5 -right-0.5 rounded-sm bg-zinc-950 text-emerald-400"
      />
    </span>
  );
}
