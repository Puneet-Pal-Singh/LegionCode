import { LucideIcon } from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@legioncode/client-ui";

interface SidebarNavItemProps {
  icon: LucideIcon;
  label: string;
  isActive?: boolean;
  onClick?: () => void;
  href?: string;
}

export function SidebarNavItem({
  icon: Icon,
  label,
  isActive = false,
  onClick,
  href,
}: SidebarNavItemProps) {
  const baseClasses = cn(
    "flex items-center gap-2.5 px-2.5 py-1.5 text-xs font-medium rounded-md transition-all duration-200",
    isActive
      ? "text-white bg-zinc-800/60 shadow-sm"
      : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40",
  );

  const content = (
    <>
      <Icon
        size={14}
        className={cn(
          "shrink-0 transition-colors duration-200",
          isActive ? "text-white" : "text-zinc-500 group-hover:text-zinc-400",
        )}
      />
      <span className="truncate">{label}</span>
    </>
  );

  if (href) {
    return (
      <a href={href} className={cn(baseClasses, "group")}>
        {content}
      </a>
    );
  }

  return (
    <motion.button
      onClick={onClick}
      whileHover={{ scale: 1.01, x: 1 }}
      whileTap={{ scale: 0.99 }}
      transition={{ duration: 0.15 }}
      className={cn(baseClasses, "w-full text-left group")}
    >
      {content}
    </motion.button>
  );
}
