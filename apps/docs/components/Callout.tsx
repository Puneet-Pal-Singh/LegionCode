import React from "react";
import { Info, AlertTriangle, Lightbulb, ListTodo } from "lucide-react";
import { cn } from "@/lib/utils";

interface CalloutProps {
  variant?: "info" | "warning" | "tip" | "todo";
  title?: string;
  children: React.ReactNode;
  className?: string;
}

export function Callout({
  variant = "info",
  title,
  children,
  className,
}: CalloutProps) {
  const styles = {
    info: {
      bg: "bg-zinc-900/50",
      border: "border-white/5",
      text: "text-zinc-350",
      iconBg: "bg-white/10",
      iconColor: "text-white",
      icon: <Info className="w-4 h-4 flex-shrink-0" />,
      defaultTitle: "Information",
    },
    warning: {
      bg: "bg-amber-950/20",
      border: "border-amber-900/30",
      text: "text-zinc-300",
      iconBg: "bg-amber-500/10",
      iconColor: "text-amber-400",
      icon: <AlertTriangle className="w-4 h-4 flex-shrink-0" />,
      defaultTitle: "Warning",
    },
    tip: {
      bg: "bg-emerald-950/20",
      border: "border-emerald-900/30",
      text: "text-zinc-300",
      iconBg: "bg-emerald-500/10",
      iconColor: "text-emerald-400",
      icon: <Lightbulb className="w-4 h-4 flex-shrink-0" />,
      defaultTitle: "Pro Tip",
    },
    todo: {
      bg: "bg-violet-950/25",
      border: "border-violet-900/30",
      text: "text-zinc-300",
      iconBg: "bg-violet-500/10",
      iconColor: "text-violet-400",
      icon: <ListTodo className="w-4 h-4 flex-shrink-0" />,
      defaultTitle: "Technical TODO",
    },
  };

  const current = styles[variant];

  return (
    <div
      className={cn(
        "my-5 flex gap-3 p-4 rounded-lg border items-start",
        current.bg,
        current.border,
        className,
      )}
    >
      <div
        className={cn(
          "p-1.5 rounded-md flex-shrink-0",
          current.iconBg,
          current.iconColor,
        )}
      >
        {current.icon}
      </div>
      <div className="flex-1 text-xs sm:text-sm leading-normal text-zinc-300">
        <h5 className="font-bold text-white mb-0.5 leading-snug">
          {title || current.defaultTitle}
        </h5>
        <div className="text-zinc-400 font-sans leading-normal">{children}</div>
      </div>
    </div>
  );
}
