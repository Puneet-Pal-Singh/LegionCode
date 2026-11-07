import { AnimatePresence, motion } from "framer-motion";
import { useState, type ReactNode } from "react";
import { Resizer } from "./Resizer.js";

export function WorkspaceTreeDrawer({
  kind,
  onClose,
  children,
}: {
  kind: "changes" | "files" | null;
  onClose: () => void;
  children: ReactNode;
}) {
  const isOpen = kind !== null;
  const [drawerWidth, setDrawerWidth] = useState<number | null>(null);
  const resizeDrawer = (delta: number) => {
    setDrawerWidth((currentWidth) => {
      const drawer = document.querySelector<HTMLElement>(
        "[data-sidebar-tree-drawer]",
      );
      const parentWidth = drawer?.parentElement?.clientWidth ?? 0;
      const nextWidth = Math.min(
        parentWidth,
        (currentWidth ?? drawer?.offsetWidth ?? 0) + delta,
      );
      if (nextWidth <= 80) {
        onClose();
        return null;
      }
      return nextWidth;
    });
  };

  return (
    <AnimatePresence>
      {isOpen ? (
        <motion.aside
          key={kind}
          initial={{ x: "100%", opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: "100%", opacity: 0 }}
          transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
          data-sidebar-tree-drawer
          className="absolute bottom-0 right-0 top-[60px] z-30 flex min-w-0 max-w-full flex-col overflow-hidden border-l border-zinc-800 bg-black shadow-[-18px_0_36px_rgba(0,0,0,0.35)]"
          style={{ width: drawerWidth ?? "50%" }}
        >
          <Resizer side="right" onResize={resizeDrawer} />
          {children}
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
}
