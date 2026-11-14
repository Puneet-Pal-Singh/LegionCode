import { useEffect, useRef, useState } from "react";
import type { DesktopBuildInfo } from "../../shared/desktop-api";
import { DesktopLocalWorkspace } from "./DesktopLocalWorkspace";
import { DesktopHostedWorkspace } from "./DesktopHostedWorkspace";
import { useDesktopHostedAccount } from "./useDesktopHostedAccount";

/** Placement is a view choice. Mounted controllers retain their original request custody. */
export function DesktopHost() {
  const account = useDesktopHostedAccount();
  const [build, setBuild] = useState<DesktopBuildInfo | null>(null);
  const [placement, setPlacement] = useState<"local" | "cloud">("local");
  const [cloudVisited, setCloudVisited] = useState(false);
  const [nativeOpenRequestId, setNativeOpenRequestId] = useState(0);
  const currentPlacement = useRef(placement);
  currentPlacement.current = placement;
  const choosePlacement = (next: "local" | "cloud") => {
    if (next === "cloud") setCloudVisited(true);
    setPlacement(next);
  };
  useEffect(() => {
    let current = true;
    void window.desktop.getBuildInfo().then((value) => { if (current) setBuild(value); });
    return () => { current = false; };
  }, []);
  useEffect(() => window.desktop.onOpenWorkspaceRequested(() => {
    if (currentPlacement.current !== "cloud") return;
    setPlacement("local");
    setNativeOpenRequestId((value) => value + 1);
  }), []);
  return <>
    <div hidden={placement !== "local"} inert={placement !== "local"} className="h-full min-h-0">
      <DesktopLocalWorkspace active={placement === "local"} onPlacementChange={choosePlacement}
        hostedAccount={account} nativeOpenRequestId={nativeOpenRequestId} />
    </div>
    {cloudVisited && build ? <div hidden={placement !== "cloud"} inert={placement !== "cloud"} className="h-full min-h-0">
      <DesktopHostedWorkspace active={placement === "cloud"} build={build}
        account={account} onPlacementChange={choosePlacement} />
    </div> : null}
  </>;
}
