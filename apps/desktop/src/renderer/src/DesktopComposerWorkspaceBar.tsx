import { ComposerWorkspaceBar } from "@legioncode/client-ui";

/** Native selection stays with Main's existing picker/token/grant owner. */
export function DesktopComposerWorkspaceBar({
  scopeKey,
  projectName,
  onChooseProject,
  projectUnavailableReason,
  disabledReason,
}: {
  scopeKey: string;
  projectName?: string;
  /** The existing host chooser reports command failures through its own notice. */
  onChooseProject?: () => void;
  projectUnavailableReason?: string;
  disabledReason?: string;
}) {
  return (
    <ComposerWorkspaceBar
      scopeKey={scopeKey}
      project={{
        label: projectName ?? "Choose project",
        onOpen: onChooseProject,
        unavailableReason: projectUnavailableReason,
      }}
      placement="local"
      placementOptions={[
        { value: "local" },
        { value: "cloud", unavailableReason: "Cloud execution is unavailable in this Desktop session." },
      ]}
      disabledReason={disabledReason}
    />
  );
}
