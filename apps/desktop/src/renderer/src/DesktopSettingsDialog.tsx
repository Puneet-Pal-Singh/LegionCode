import { useEffect, useId, useRef } from "react";
import type { AppServerClient } from "@legioncode/sdk";
import type { DesktopBuildInfo } from "../../shared/desktop-api";
import { DesktopProviderSetup } from "./DesktopProviderSetup";

interface Props {
  open: boolean;
  onClose: () => void;
  client: AppServerClient | null;
  ready: boolean;
  build: DesktopBuildInfo;
}

export function DesktopSettingsDialog({ open, onClose, client, ready, build }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog ref={dialog} className="desktop-settings-dialog" aria-labelledby={title} onClose={onClose}>
      <header className="desktop-settings-header">
        <div><h2 id={title}>Settings</h2><p>Local providers and models</p></div>
        <button type="button" autoFocus onClick={() => dialog.current?.close()}>Close settings</button>
      </header>
      <div className="desktop-settings-body">
        {open ? <DesktopProviderSetup client={client} ready={ready} /> : null}
        <details className="desktop-about">
          <summary>About LegionCode Desktop</summary>
          <dl><div><dt>Version</dt><dd>{build.version}</dd></div><div><dt>Platform</dt><dd>{build.platform} · {build.arch}</dd></div></dl>
        </details>
      </div>
    </dialog>
  );
}
