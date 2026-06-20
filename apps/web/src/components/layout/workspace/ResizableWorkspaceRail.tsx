import { useState, type ReactNode } from "react";
import { Resizer } from "../../ui/Resizer";

const DEFAULT_RAIL_WIDTH = 320;
const MIN_RAIL_WIDTH = 240;
const MAX_RAIL_WIDTH = 520;

interface ResizableWorkspaceRailProps {
  children: ReactNode;
  placement: "left" | "right";
  className?: string;
}

export function ResizableWorkspaceRail({
  children,
  placement,
  className = "",
}: ResizableWorkspaceRailProps) {
  const [width, setWidth] = useState(DEFAULT_RAIL_WIDTH);
  const resize = (delta: number) => {
    setWidth((current) =>
      Math.max(MIN_RAIL_WIDTH, Math.min(MAX_RAIL_WIDTH, current + delta)),
    );
  };

  return (
    <aside
      className={`relative flex shrink-0 overflow-hidden bg-black ${
        placement === "left" ? "border-r" : "border-l"
      } border-zinc-800 ${className}`}
      style={{ width }}
    >
      <Resizer
        side={placement === "left" ? "left" : "right"}
        onResize={resize}
      />
      <div className="flex min-w-0 flex-1 bg-black">{children}</div>
    </aside>
  );
}
