import { ComposerWorkspaceBar, type ComposerWorkspaceBarProps } from "@legioncode/client-ui";

interface WebComposerWorkspaceBarProps {
  scopeKey: string;
  projectName?: string;
  onProjectClick?: () => void;
  renderProjectTrigger?: ComposerWorkspaceBarProps["renderProjectTrigger"];
  projectUnavailableReason?: string;
  disabledReason?: string;
}

/** Cloud is the actual Web execution host; setup remains unavailable without a port. */
export function WebComposerWorkspaceBar({
  scopeKey,
  projectName,
  onProjectClick,
  renderProjectTrigger,
  projectUnavailableReason,
  disabledReason,
}: WebComposerWorkspaceBarProps) {
  return (
    <ComposerWorkspaceBar
      scopeKey={scopeKey}
      project={{
        label: projectName || "Select project",
        onOpen: onProjectClick,
        unavailableReason: projectUnavailableReason,
      }}
      renderProjectTrigger={renderProjectTrigger}
      placement="cloud"
      placementOptions={[
        {
          value: "local",
          unavailableReason: "Local execution is unavailable in the web app.",
        },
        { value: "cloud" },
      ]}
      cloudEnvironment={{
        label: "Environment",
        unavailableReason: "Cloud environment setup is not available yet.",
      }}
      disabledReason={disabledReason}
    />
  );
}
