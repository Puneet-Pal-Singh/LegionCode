import { motion } from "framer-motion";
import { PanelLeftClose } from "lucide-react";

interface SidebarShellProps {
  width?: number;
  utility: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  onClose?: () => void;
  version?: string;
}

export function SidebarShell({
  width = 240,
  utility,
  children,
  footer,
  onClose,
  version,
}: SidebarShellProps) {
  return (
    <aside
      className="ui-sidebar-surface flex h-full flex-col overflow-hidden border-r"
      style={{ width }}
    >
      <div className="flex h-12 items-center px-4">
        {onClose ? (
          <motion.button
            type="button"
            onClick={onClose}
            aria-label="Close sidebar"
            whileHover={{ scale: 1.04 }}
            whileTap={{ scale: 0.96 }}
            className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800/60 hover:text-zinc-200"
            title="Close sidebar"
          >
            <PanelLeftClose size={16} aria-hidden="true" />
          </motion.button>
        ) : null}
      </div>

      <div className="px-4 pb-1">{utility}</div>
      <div className="flex-1 overflow-y-auto px-4 pb-3 pt-0">{children}</div>

      {footer ? (
        <div className="border-t ui-muted-divider px-4 py-2">{footer}</div>
      ) : null}
      {version ? (
        <div className="border-t ui-muted-divider px-4 py-2 text-[10px] text-zinc-600">
          {version}
        </div>
      ) : null}
    </aside>
  );
}
