import { motion } from "framer-motion";
import { cn } from "@legioncode/client-ui";

interface SidebarSectionProps {
  title: string;
  children: React.ReactNode;
  action?: {
    icon: React.ElementType;
    onClick: () => void;
    label: string;
  };
  secondaryAction?: {
    icon: React.ElementType;
    onClick: () => void;
    label: string;
  };
  className?: string;
}

export function SidebarSection({
  title,
  children,
  action,
  secondaryAction,
  className,
}: SidebarSectionProps) {
  return (
    <div className={cn("mb-6", className)}>
      <div className="flex items-center justify-between px-3 mb-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-600">
          {title}
        </h3>
        <div className="flex items-center gap-1">
          {action && (
            <motion.button
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.9 }}
              onClick={action.onClick}
              className="p-1 text-zinc-500 hover:text-zinc-300 transition-colors"
              title={action.label}
            >
              <action.icon size={14} />
            </motion.button>
          )}
          {secondaryAction && (
            <motion.button
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.9 }}
              onClick={secondaryAction.onClick}
              className="p-1 text-zinc-500 hover:text-zinc-300 transition-colors"
              title={secondaryAction.label}
            >
              <secondaryAction.icon size={14} />
            </motion.button>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}
