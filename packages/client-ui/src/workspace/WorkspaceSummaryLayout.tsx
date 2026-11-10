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

interface HeaderInsetRegistration {
  update: (width: number) => void;
  release: () => void;
}
interface SummaryLayout {
  headerInset: number;
  registerHeaderInset: () => HeaderInsetRegistration;
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
  const [headerInset, setHeaderInset] = useState(0);
  const headerOwner = useRef<symbol | null>(null);
  const registerHeaderInset = useCallback((): HeaderInsetRegistration => {
    const owner = Symbol("fixed-pane-header");
    headerOwner.current = owner;
    setHeaderInset(0);
    return {
      update(width) {
        if (headerOwner.current !== owner || !Number.isFinite(width) || width < 0) return;
        setHeaderInset((current) => current === width ? current : width);
      },
      release() {
        if (headerOwner.current !== owner) return;
        headerOwner.current = null;
        setHeaderInset(0);
      },
    };
  }, []);
  const [inlineEligible, setEligible] = useState(false);
  const eligibleRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [hasSummary, setHasSummary] = useState(false);
  const [inlineTarget, setTarget] = useState<HTMLDivElement | null>(null);
  const inlineRef = useRef<HTMLDivElement | null>(null);
  const [overlayTarget, setOverlayElement] = useState<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const setInlineTarget = useCallback((element: HTMLDivElement | null) => {
    inlineRef.current = element;
    setTarget(element);
  }, []);
  const registerTrigger = useCallback((element: HTMLButtonElement | null) => {
    triggerRef.current = element;
  }, []);
  const setOverlayTarget = useCallback((element: HTMLDivElement | null) => {
    overlayRef.current = element;
    setOverlayElement(element);
  }, []);
  const setInlineEligible = useCallback((eligible: boolean) => {
    if (eligibleRef.current === eligible) return;
    // Move focus before a measured collapse removes the inline card.
    if (inlineRef.current?.contains(document.activeElement) ||
        overlayRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
    eligibleRef.current = eligible;
    setEligible(eligible);
  }, []);
  const dismissPopup = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((current) => !current), []);
  const value = useMemo(() => ({
    headerInset,
    registerHeaderInset,
    inlineEligible,
    inlineVisible: hasSummary && inlineEligible && open,
    popupOpen: !inlineEligible && open,
    inlineTarget,
    overlayTarget,
    setInlineTarget,
    setOverlayTarget,
    setInlineEligible,
    setHasSummary,
    registerTrigger,
    toggle,
    dismissPopup,
  }), [headerInset, registerHeaderInset, inlineEligible, hasSummary, open, inlineTarget, overlayTarget,
    setInlineTarget, setOverlayTarget, setInlineEligible, registerTrigger, toggle, dismissPopup]);
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
  const footprintRef = useRef<HTMLDivElement>(null);
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
      const footprint = footprintRef.current?.getBoundingClientRect();
      // The rail stays at the container's right edge. A large intersection alone
      // can leave it offscreen during pinch/pan or behind the on-screen keyboard.
      const contained = rectangle.left >= visible.left - 0.5 && rectangle.top >= visible.top - 0.5 &&
        rectangle.right <= visible.right + 0.5 && rectangle.bottom <= visible.bottom + 0.5;
      // Like T3's measured chat lane, the CSS footprint resolves rem sizing and
      // retains minimum chat width plus the existing card, clearance and edges.
      setInlineEligible(Boolean(allowInline && contained && footprint && width >= footprint.width && height >= footprint.height));
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(container);
    if (footprintRef.current) observer?.observe(footprintRef.current);
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
      <div ref={footprintRef} aria-hidden="true" className="lc-workspace-summary-footprint" />
      <div className="lc-workspace-summary-conversation">{children}</div>
      {layout?.inlineVisible ? (
        <aside aria-label="Chat environment summary" className="lc-workspace-summary-rail">
          <div ref={layout.setInlineTarget} />
        </aside>
      ) : null}
    </div>
  );
}
