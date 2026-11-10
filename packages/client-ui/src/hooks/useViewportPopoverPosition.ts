import {
  useLayoutEffect,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

type PopoverPosition = Omit<CSSProperties, "maxHeight"> & { maxHeight?: number };

/** Visible CSS-pixel bounds in the layout coordinates used by fixed popovers. */
export function getVisibleViewportBounds() {
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0;
  const top = viewport?.offsetTop ?? 0;
  const width = viewport?.width ?? window.innerWidth;
  const height = viewport?.height ?? window.innerHeight;
  return { left, top, width, height, right: left + width, bottom: top + height };
}

/** One measured placement owner for fixed popovers, including portalled menus. */
export function useViewportPopoverPosition(
  isOpen: boolean,
  triggerRef: RefObject<HTMLElement | null>,
  panelRef: RefObject<HTMLElement | null>,
  {
    align = "end",
    placement = "below",
    viewportPadding = 8,
    gap = 8,
    preferredWidth,
    minWidth = 0,
  }: {
    align?: "start" | "end" | "auto";
    placement?: "above" | "below" | "auto";
    viewportPadding?: number;
    gap?: number;
    preferredWidth?: number;
    minWidth?: number;
  } = {},
): PopoverPosition {
  const [position, setPosition] = useState<PopoverPosition>({
    position: "fixed",
    left: 0,
    top: 0,
    visibility: "hidden",
  });

  useLayoutEffect(() => {
    if (!isOpen) return;
    const visualViewport = window.visualViewport;
    const updatePosition = () => {
      const trigger = triggerRef.current?.getBoundingClientRect();
      const panel = panelRef.current?.getBoundingClientRect();
      if (!trigger || !panel) return;

      // VisualViewport dimensions are already CSS pixels, including pinch zoom.
      const {
        left: viewportLeft,
        top: viewportTop,
        width: viewportWidth,
        height: viewportHeight,
        right: viewportRight,
        bottom: viewportBottom,
      } = getVisibleViewportBounds();
      const availableWidth = Math.max(0, viewportWidth - viewportPadding * 2);
      const spaceRight = viewportRight - trigger.left - viewportPadding;
      const spaceLeft = trigger.right - viewportLeft - viewportPadding;
      const desiredWidth = preferredWidth ?? panel.width;
      const horizontal =
        align === "auto"
          ? spaceRight < desiredWidth && spaceLeft > spaceRight ? "end" : "start"
          : align;
      const width =
        preferredWidth === undefined
          ? Math.min(panel.width, availableWidth)
          : Math.min(
              availableWidth,
              Math.max(
                minWidth,
                Math.min(
                  preferredWidth,
                  Math.floor(horizontal === "start" ? spaceRight : spaceLeft),
                ),
              ),
            );
      const left = Math.max(
        viewportLeft + viewportPadding,
        Math.min(
          horizontal === "start" ? trigger.left : trigger.right - width,
          viewportRight - width - viewportPadding,
        ),
      );
      const maxHeight = Math.max(0, viewportHeight - viewportPadding * 2);
      const height = Math.min(panel.height, maxHeight);
      const spaceBelow =
        viewportBottom - trigger.bottom - gap - viewportPadding;
      const spaceAbove = trigger.top - viewportTop - gap - viewportPadding;
      const above =
        placement === "above"
          ? height <= spaceAbove || spaceAbove > spaceBelow
          : height > spaceBelow && spaceAbove > spaceBelow;
      const desiredTop = above
        ? trigger.top - height - gap
        : trigger.bottom + gap;
      const top = Math.max(
        viewportTop + viewportPadding,
        Math.min(desiredTop, viewportBottom - height - viewportPadding),
      );
      setPosition((current) => {
        const nextWidth = preferredWidth === undefined ? undefined : width;
        if (
          current.left === left &&
          current.top === top &&
          current.maxHeight === maxHeight &&
          current.maxWidth === availableWidth &&
          current.width === nextWidth &&
          current.visibility === "visible"
        ) return current;
        return {
          position: "fixed",
          left,
          top,
          maxHeight,
          maxWidth: availableWidth,
          width: nextWidth,
          visibility: "visible",
        };
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    visualViewport?.addEventListener("resize", updatePosition);
    visualViewport?.addEventListener("scroll", updatePosition);
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(updatePosition);
    if (panelRef.current) resizeObserver?.observe(panelRef.current);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      visualViewport?.removeEventListener("resize", updatePosition);
      visualViewport?.removeEventListener("scroll", updatePosition);
      resizeObserver?.disconnect();
    };
  }, [
    align,
    gap,
    isOpen,
    minWidth,
    panelRef,
    placement,
    preferredWidth,
    triggerRef,
    viewportPadding,
  ]);

  return position;
}
