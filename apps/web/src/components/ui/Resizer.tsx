import { useState, useCallback, useEffect, useRef } from "react";
import { cn } from "@legioncode/client-ui";

interface ResizerProps {
  onResize: (delta: number) => void;
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
  orientation?: "horizontal" | "vertical";
  className?: string;
  side?: "left" | "right";
}

export function Resizer({ 
  onResize, 
  onResizeStart,
  onResizeEnd,
  orientation = "horizontal", 
  className = "",
  side = "left"
}: ResizerProps) {
  const [isResizing, setIsResizing] = useState(false);
  const lastPos = useRef(0);

  const startResizing = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    lastPos.current = orientation === "horizontal" ? e.clientX : e.clientY;
    onResizeStart?.();
  }, [orientation, onResizeStart]);

  const stopResizing = useCallback(() => {
    setIsResizing(false);
    onResizeEnd?.();
  }, [onResizeEnd]);

  const resize = useCallback(
    (e: MouseEvent) => {
      if (isResizing) {
        const currentPos = orientation === "horizontal" ? e.clientX : e.clientY;
        const delta = side === "left" ? currentPos - lastPos.current : lastPos.current - currentPos;
        onResize(delta);
        lastPos.current = currentPos;
      }
    },
    [isResizing, onResize, side, orientation]
  );

  useEffect(() => {
    if (isResizing) {
      window.addEventListener("mousemove", resize);
      window.addEventListener("mouseup", stopResizing);
      document.body.style.cursor = orientation === "horizontal" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
    } else {
      window.removeEventListener("mousemove", resize);
      window.removeEventListener("mouseup", stopResizing);
      document.body.style.cursor = "default";
      document.body.style.userSelect = "auto";
    }

    return () => {
      window.removeEventListener("mousemove", resize);
      window.removeEventListener("mouseup", stopResizing);
      document.body.style.cursor = "default";
      document.body.style.userSelect = "auto";
    };
  }, [isResizing, resize, stopResizing, orientation]);

  return (
    <div
      onMouseDown={startResizing}
      className={cn(
        "absolute z-50 transition-colors hover:bg-white/20",
        orientation === "horizontal" 
          ? "w-1.5 h-full cursor-col-resize top-0" 
          : "h-1.5 w-full cursor-row-resize left-0",
        side === "left" ? "-right-0.5" : "-left-0.5",
        isResizing && "bg-white",
        className
      )}
    />
  );
}