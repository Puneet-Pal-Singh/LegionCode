import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getVisibleViewportBounds } from "../hooks/useViewportPopoverPosition.js";

interface SummaryLayout {
  inlineEligible: boolean;
  inlineVisible: boolean;
  popupOpen: boolean;
  inlineTarget: HTMLDivElement | null;
  overlayTarget: HTMLDivElement | null;
  setInlineTarget: (element: HTMLDivElement | null) => void;
  setOverlayTarget: (element: HTMLDivElement | null) => void;
  setInlineEligible: (eligible: boolean) => void;
  setHasSummary: (present: boolean) => void;
  registerTrigger: (element: HTMLButtonElement | null) => void;
  toggle: () => void;
  dismissPopup: () => void;
}
const SummaryLayoutContext = createContext<SummaryLayout | null>(null);
export const useWorkspaceSummaryLayout = () => useContext(SummaryLayoutContext);

/** Transient presentation preference only; environment data remains in host adapters. */
export function WorkspaceSummaryProvider({ children }: { children: ReactNode }) {
  const [inlineEligible, setEligible] = useState(false);
  const eligibleRef = useRef(false);
  const [inlineHidden, setInlineHidden] = useState(false);
  const [popupOpen, setPopupOpen] = useState(false);
  const [hasSummary, setHasSummary] = useState(false);
  const [inlineTarget, setTarget] = useState<HTMLDivElement | null>(null);
  const inlineRef = useRef<HTMLDivElement | null>(null);
  const [overlayTarget, setOverlayTarget] = useState<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const setInlineTarget = useCallback((element: HTMLDivElement | null) => {
    inlineRef.current = element;
    setTarget(element);
  }, []);
  const registerTrigger = useCallback((element: HTMLButtonElement | null) => {
    triggerRef.current = element;
  }, []);
  const setInlineEligible = useCallback((eligible: boolean) => {
    if (eligibleRef.current === eligible) return;
    // Move focus before a measured collapse removes the inline card.
    if (inlineRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
    eligibleRef.current = eligible;
    setEligible(eligible);
    setPopupOpen(false);
  }, []);
  const dismissPopup = useCallback(() => setPopupOpen(false), []);
  const toggle = useCallback(() => {
    if (eligibleRef.current) setInlineHidden((hidden) => !hidden);
    else setPopupOpen((open) => !open);
  }, []);
  const value = useMemo(() => ({
    inlineEligible,
    inlineVisible: hasSummary && inlineEligible && !inlineHidden,
    popupOpen,
    inlineTarget,
    overlayTarget,
    setInlineTarget,
    setOverlayTarget,
    setInlineEligible,
    setHasSummary,
    registerTrigger,
    toggle,
    dismissPopup,
  }), [inlineEligible, hasSummary, inlineHidden, popupOpen, inlineTarget, overlayTarget,
    setInlineTarget, setInlineEligible, registerTrigger, toggle, dismissPopup]);
  return <SummaryLayoutContext.Provider value={value}>{children}</SummaryLayoutContext.Provider>;
}

/** Fixed popovers stay outside animated headers and inside the frame's inert boundary. */
export function WorkspaceSummaryOverlay() {
  const layout = useWorkspaceSummaryLayout();
  return <div className="contents" ref={layout?.setOverlayTarget} />;
}

/** Reserve a real column beside the conversation, measured after all surrounding rails. */
export function WorkspaceSummaryLayout({ children, allowInline = true }: {
  children: ReactNode;
  allowInline?: boolean;
}) {
  const layout = useWorkspaceSummaryLayout();
  const containerRef = useRef<HTMLDivElement>(null);
  const setInlineEligible = layout?.setInlineEligible;
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !setInlineEligible) return;
    const viewport = window.visualViewport;
    const measure = () => {
      const rectangle = container.getBoundingClientRect();
      const visible = getVisibleViewportBounds();
      const width = Math.max(0, Math.min(rectangle.right, visible.right) - Math.max(rectangle.left, visible.left));
      const height = Math.max(0, Math.min(rectangle.bottom, visible.bottom) - Math.max(rectangle.top, visible.top));
      const rem = Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
      // 36rem conversation + 21.25rem existing card + gaps; short viewports use the popup.
      setInlineEligible(allowInline && width >= 60 * rem && height >= 22 * rem);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(container);
    window.addEventListener("resize", measure);
    viewport?.addEventListener("resize", measure);
    viewport?.addEventListener("scroll", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      viewport?.removeEventListener("resize", measure);
      viewport?.removeEventListener("scroll", measure);
      setInlineEligible(false);
    };
  }, [allowInline, setInlineEligible]);
  return (
    <div ref={containerRef} className="lc-workspace-summary-layout">
      <div className="lc-workspace-summary-conversation">{children}</div>
      {layout?.inlineVisible ? (
        <aside aria-label="Chat environment summary" className="lc-workspace-summary-rail">
          <div ref={layout.setInlineTarget} />
        </aside>
      ) : null}
    </div>
  );
}
