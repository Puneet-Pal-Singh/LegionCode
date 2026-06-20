import { Atom, Braces, File, FileCode2, FileText } from "lucide-react";
import { cn } from "../../lib/utils";

interface FileTypeIconProps {
  path: string;
  size?: number;
  className?: string;
}

export function FileTypeIcon({ path, size = 16, className }: FileTypeIconProps) {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";

  if (extension === "tsx" || extension === "jsx") {
    return <Atom size={size} className={cn("text-cyan-400", className)} />;
  }

  if (extension === "ts" || extension === "js") {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded bg-blue-400/20 font-sans font-semibold text-blue-300",
          className,
        )}
        style={{ width: size + 2, height: size + 2, fontSize: Math.max(8, size - 6) }}
      >
        {extension.toUpperCase()}
      </span>
    );
  }

  if (extension === "json") {
    return <Braces size={size} className={cn("text-yellow-400", className)} />;
  }

  if (["md", "mdx", "txt", "yml", "yaml"].includes(extension)) {
    return <FileText size={size} className={cn("text-amber-400", className)} />;
  }

  if (["css", "scss", "html", "py", "go", "rs", "java"].includes(extension)) {
    return <FileCode2 size={size} className={cn("text-sky-400", className)} />;
  }

  return <File size={size} className={cn("text-zinc-500", className)} />;
}
