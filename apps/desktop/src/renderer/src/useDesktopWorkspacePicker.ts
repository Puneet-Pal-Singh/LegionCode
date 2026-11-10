import { useCallback, useEffect, useRef } from "react";
import type { WorkspaceSelection } from "../../shared/desktop-api";

/** Native Open is the user's grant intent; only the existing token flow adds it. */
export function useDesktopWorkspacePicker(input: {
  enabled: boolean;
  commandActive: { current: boolean };
  pickerActive: { current: boolean };
  onOpenChange: (open: boolean) => void;
  onStart: (preserveProjectIntent: boolean) => void;
  onPicked: (selection: WorkspaceSelection) => Promise<void>;
  onCancel: () => void;
  onError: () => void;
}) {
  const current = useRef(input);
  current.current = input;
  const choose = useCallback(async (preserveProjectIntent = false): Promise<void> => {
    const context = current.current;
    if (!context.enabled || context.commandActive.current || context.pickerActive.current) return;
    context.pickerActive.current = true;
    context.onOpenChange(true);
    try {
      context.onStart(preserveProjectIntent);
      const selected = await window.desktop.pickWorkspace();
      if (!selected) {
        current.current.onCancel();
        return;
      }
      if (!current.current.enabled) {
        current.current.onError();
        return;
      }
      // Grant fences synchronously; its post-grant task selection is no longer
      // inside the native picker and must use the returned canonical workspace.
      context.pickerActive.current = false;
      await current.current.onPicked(selected);
    } catch {
      current.current.onError();
    } finally {
      context.pickerActive.current = false;
      context.onOpenChange(false);
    }
  }, []);

  useEffect(() => window.desktop.onOpenWorkspaceRequested(() => {
    void choose();
  }), [choose]);
  return choose;
}
