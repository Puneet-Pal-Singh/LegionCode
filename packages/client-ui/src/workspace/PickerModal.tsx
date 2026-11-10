import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Shared repository-picker overlay. Dialog children own their focus lifetime. */
export function PickerModal({ children, layer = "default", backdrop = true }: { children: ReactNode; layer?: "default" | "dialog"; backdrop?: boolean }) {
  useEffect(() => {
    const root = document.getElementById("root");
    const wasInert = root?.inert;
    if (root) root.inert = true;
    return () => {
      if (root) root.inert = wasInert ?? false;
    };
  }, []);
  return createPortal(
    <div className={`fixed inset-0 ${layer === "dialog" ? "z-[120]" : "z-50"} flex items-center justify-center p-3 sm:p-6 ${backdrop ? "bg-black/45 backdrop-blur-[2px]" : ""}`}>
      {children}
    </div>,
    document.body,
  );
}
