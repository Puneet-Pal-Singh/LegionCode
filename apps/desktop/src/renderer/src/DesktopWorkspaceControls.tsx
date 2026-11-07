import type { LocalWorkspaceGrant } from "@repo/platform-protocol";
import type { WorkspaceSelection } from "../../shared/desktop-api";

interface Props {
  workspace: LocalWorkspaceGrant | null;
  selection: WorkspaceSelection | null;
  ready: boolean;
  busy: boolean;
  error: string | null;
  onChoose: () => void;
  onGrant: () => void;
  onCancelSelection: () => void;
  onRevoke: () => void;
  onSettings: () => void;
}

export function DesktopWorkspaceControls(props: Props) {
  return (
    <div className="desktop-rail-footer">
      {props.selection ? (
        <section className="desktop-workspace-confirm" aria-label="Selected folder">
          <p>Allow access to <strong>{props.selection.displayName}</strong>?</p>
          <div className="desktop-inline-actions">
            <button type="button" disabled={!props.ready || props.busy} onClick={props.onGrant}>Grant access</button>
            <button type="button" disabled={props.busy} onClick={props.onCancelSelection}>Cancel</button>
          </div>
        </section>
      ) : null}
      {props.error ? <p role="alert" className="desktop-rail-error">{props.error}</p> : null}
      <div className="desktop-workspace-summary">
        <span className="desktop-rail-caption">Workspace</span>
        <strong>{props.workspace?.displayName ?? "No folder selected"}</strong>
        {props.workspace?.branch ? <span>{props.workspace.branch}</span> : null}
        {props.workspace?.readiness === "missing" ? <p role="status">{props.workspace.reason}</p> : null}
      </div>
      <div className="desktop-inline-actions">
        <button type="button" disabled={!props.ready || props.busy} onClick={props.onChoose}>Choose folder</button>
        {props.workspace ? <button type="button" disabled={!props.ready || props.busy} onClick={props.onRevoke}>Revoke access</button> : null}
      </div>
      <button type="button" className="desktop-settings-button" onClick={props.onSettings}>Settings</button>
    </div>
  );
}
