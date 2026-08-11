import { motion } from "framer-motion";
import { PanelLeftClose } from "lucide-react";
import { useState } from "react";

interface SidebarShellProps {
  width?: number;
  header?: React.ReactNode;
  utility: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  onClose?: () => void;
  version?: string;
}

export function SidebarShell({
  width = 240,
  header,
  utility,
  children,
  footer,
  onClose,
  version,
}: SidebarShellProps) {
  const [isContentScrolled, setIsContentScrolled] = useState(false);

  return (
    <aside
      className="ui-sidebar-surface flex h-full flex-col overflow-hidden border-r"
      style={{ width }}
    >
      <div className="flex h-14 shrink-0 items-center px-4">
        {header ? <div className="min-w-0 flex-1">{header}</div> : null}
        {onClose ? (
          <motion.button
            type="button"
            onClick={onClose}
            aria-label="Close sidebar"
            whileHover={{ scale: 1.04 }}
            whileTap={{ scale: 0.96 }}
            className="grid size-8 shrink-0 place-items-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-800/60 hover:text-zinc-200"
            title="Close sidebar"
          >
            <PanelLeftClose size={16} aria-hidden="true" />
          </motion.button>
        ) : null}
      </div>

      <div
        data-testid="sidebar-utility"
        data-content-scrolled={isContentScrolled ? "true" : "false"}
        className={`shrink-0 px-4 pb-3 pt-3 ${
          isContentScrolled ? "border-b ui-muted-divider" : ""
        }`}
      >
        {utility}
      </div>
      <div
        className="sidebar-scroll-region flex-1 overflow-y-auto px-4 pb-3 pt-3"
        onScroll={(event) => {
          setIsContentScrolled(event.currentTarget.scrollTop > 0);
        }}
      >
        {children}
      </div>

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
