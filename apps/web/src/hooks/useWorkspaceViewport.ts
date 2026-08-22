import { useEffect, useState } from "react";

const MOBILE_QUERY = "(max-width: 767px)";
const COMPACT_QUERY = "(max-width: 1023px)";

export interface WorkspaceViewport {
  isMobile: boolean;
  isCompact: boolean;
}

function readViewport(): WorkspaceViewport {
  if (typeof window.matchMedia !== "function") {
    return { isMobile: false, isCompact: false };
  }
  return {
    isMobile: window.matchMedia(MOBILE_QUERY).matches,
    isCompact: window.matchMedia(COMPACT_QUERY).matches,
  };
}

export function useWorkspaceViewport(): WorkspaceViewport {
  const [viewport, setViewport] = useState(readViewport);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mobile = window.matchMedia(MOBILE_QUERY);
    const compact = window.matchMedia(COMPACT_QUERY);
    const update = () => setViewport(readViewport());
    mobile.addEventListener("change", update);
    compact.addEventListener("change", update);
    update();
    return () => {
      mobile.removeEventListener("change", update);
      compact.removeEventListener("change", update);
    };
  }, []);

  return viewport;
}
