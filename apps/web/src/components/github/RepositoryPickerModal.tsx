import { useEffect } from "react";
import { createPortal } from "react-dom";
import { AuthorizedRepositoryPicker } from "./AuthorizedRepositoryPicker";
import type { Repository } from "../../services/GitHubService";

export function RepositoryPickerModal(props: {
  onRepoSelect: (repo: Repository, branch: string) => void | Promise<void>;
  onClose: () => void;
}) {
  useEffect(() => {
    const previousFocus = document.activeElement;
    const root = document.getElementById("root");
    const wasInert = root?.inert;
    if (root) root.inert = true;
    return () => {
      if (root) root.inert = wasInert ?? false;
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, []);
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-3 backdrop-blur-[2px] sm:p-6">
      <AuthorizedRepositoryPicker {...props} />
    </div>,
    document.body,
  );
}
