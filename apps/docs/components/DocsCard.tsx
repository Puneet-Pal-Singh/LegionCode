import React from "react";
import { cn } from "@/lib/utils";

interface DocsCardProps {
  title: string;
  description: string;
  icon?: React.ReactNode;
  className?: string;
  onClick?: () => void;
}

export function DocsCard({
  title,
  description,
  icon,
  className,
  onClick,
}: DocsCardProps) {
  const cardClassName = cn(
    "p-4 rounded-lg border border-white/5 bg-zinc-900/30 text-left text-zinc-300 transition-all duration-200 group flex flex-col justify-between h-full",
    onClick
      ? "cursor-pointer hover:border-white/10 hover:bg-zinc-900/50"
      : "cursor-default",
    className,
  );
  const content = (
    <div>
      {icon && (
        <div className="mb-2 text-zinc-400 group-hover:text-zinc-200 transition-colors duration-150">
          {icon}
        </div>
      )}
      <h4 className="text-sm font-bold text-zinc-200 mb-1.5 group-hover:text-white transition-colors duration-150">
        {title}
      </h4>
      <p className="text-xs text-zinc-450 leading-normal line-clamp-3">
        {description}
      </p>
    </div>
  );

  if (!onClick) {
    return <div className={cardClassName}>{content}</div>;
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={cardClassName}
    >
      {content}
    </button>
  );
}
