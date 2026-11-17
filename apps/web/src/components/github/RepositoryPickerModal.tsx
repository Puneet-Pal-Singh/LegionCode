import { PickerModal } from "@legioncode/client-ui";
import { AuthorizedRepositoryPicker } from "./AuthorizedRepositoryPicker";
import type { Repository } from "../../services/GitHubService";

export function RepositoryPickerModal(props: {
  onRepoSelect: (repo: Repository, branch: string) => void | Promise<void>;
  onClose: () => void;
}) {
  return (
    <PickerModal>
      <AuthorizedRepositoryPicker {...props} />
    </PickerModal>
  );
}
