import { WorkspaceTabStrip as SharedWorkspaceTabStrip } from "@legioncode/client-ui";
import type { ComponentProps } from "react";
import type { SidebarContentTab } from "./useWorkspaceState";
type Props = Omit<
  ComponentProps<typeof SharedWorkspaceTabStrip>,
  "contentTabs"
> & { contentTabs: SidebarContentTab[] };
export function WorkspaceTabStrip(props: Props) {
  return <SharedWorkspaceTabStrip {...props} />;
}
