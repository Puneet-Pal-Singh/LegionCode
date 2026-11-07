import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** The existing Web repository-picker overlay, shared unchanged across clients. */
export function PickerModal({ children, layer = "default" }: { children: ReactNode; layer?: "default" | "dialog" }) {
  useEffect(() => {
    const previousFocus = document.activeElement;
    const root = document.getElementById("root");
    const wasInert = root?.inert;
    if (root) root.inert = true;
    return () => {
      if (root) root.inert = wasInert ?? false;
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, []);
  return createPortal(
    <div className={`fixed inset-0 ${layer === "dialog" ? "z-[120]" : "z-50"} flex items-center justify-center bg-black/45 p-3 backdrop-blur-[2px] sm:p-6`}>
      {children}
    </div>,
    document.body,
  );
}
