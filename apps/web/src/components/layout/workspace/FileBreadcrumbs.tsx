import { ChevronRight } from "lucide-react";

export function FileBreadcrumbs({ path }: { path: string }) {
  const segments = path.split("/").filter(Boolean);

  return (
    <div className="flex min-w-0 flex-1 items-center overflow-hidden text-xs text-zinc-500">
      {segments.length === 0 ? (
        <span className="px-1 text-zinc-300">/</span>
      ) : null}
      {segments.map((segment, index) => (
        <div key={`${segment}:${index}`} className="flex min-w-0 items-center">
          {index > 0 ? (
            <ChevronRight size={13} className="mx-0.5 shrink-0" />
          ) : null}
          <span
            className={
              index === segments.length - 1
                ? "truncate text-zinc-200"
                : "truncate"
            }
          >
            {segment}
          </span>
        </div>
      ))}
    </div>
  );
}
