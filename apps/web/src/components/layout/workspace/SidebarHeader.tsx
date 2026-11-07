import { WorkspaceSidebarHeader } from "@legioncode/client-ui";
import type { ComponentProps } from "react";
import type { SidebarContentTab } from "./useWorkspaceState";
import {
  TopEnvironmentSummary,
  type TopEnvironmentSummaryProps,
} from "../../navigation/TopEnvironmentSummary";

type SidebarHeaderProps = Omit<
  ComponentProps<typeof WorkspaceSidebarHeader>,
  "environmentSummary" | "contentTabs"
> & {
  contentTabs: SidebarContentTab[];
  environmentSummary?: TopEnvironmentSummaryProps;
};

export function SidebarHeader({
  environmentSummary,
  ...props
}: SidebarHeaderProps) {
  return (
    <WorkspaceSidebarHeader
      {...props}
      environmentSummary={
        environmentSummary ? (
          <TopEnvironmentSummary {...environmentSummary} />
        ) : null
      }
    />
  );
}
