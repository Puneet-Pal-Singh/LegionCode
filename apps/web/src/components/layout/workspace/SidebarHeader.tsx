import { WorkspaceSidebarHeader } from "@legioncode/client-ui";
import type { ComponentProps } from "react";
import type { SidebarContentTab } from "./useWorkspaceState";

type SidebarHeaderProps = Omit<
  ComponentProps<typeof WorkspaceSidebarHeader>,
  "contentTabs"
> & {
  contentTabs: SidebarContentTab[];
};

export function SidebarHeader(props: SidebarHeaderProps) {
  return <WorkspaceSidebarHeader {...props} />;
}
