import { ComposerWorkspaceBar } from "@legioncode/client-ui";

/** Native selection stays with Main's existing picker/token/grant owner. */
export function DesktopComposerWorkspaceBar({
  scopeKey,
  projectName,
  onChooseProject,
  projectUnavailableReason,
  disabledReason,
  active = true,
  onPlacementChange,
}: {
  scopeKey: string;
  projectName?: string;
  /** The existing host chooser reports command failures through its own notice. */
  onChooseProject?: () => void;
  projectUnavailableReason?: string;
  disabledReason?: string;
  active?: boolean;
  onPlacementChange?: (placement: "local" | "cloud") => void;
}) {
  return (
    <ComposerWorkspaceBar
      scopeKey={scopeKey}
      project={{
        label: projectName ?? "Choose project",
        onOpen: onChooseProject,
        unavailableReason: projectUnavailableReason ?? disabledReason,
      }}
      placement="local"
      onPlacementChange={onPlacementChange}
      placementOptions={[
        { value: "local", unavailableReason: disabledReason },
        { value: "cloud", ...(!onPlacementChange ? { unavailableReason: "Cloud execution is unavailable in this Desktop session." } : {}) },
      ]}
      disabledReason={!active ? "This view is inactive." : undefined}
    />
  );
}
