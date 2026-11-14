import { WorkspaceSurfaceHeader as SharedWorkspaceSurfaceHeader } from "@legioncode/client-ui";
import type { ComponentProps } from "react";
import type { SidebarContentTab } from "./useWorkspaceState";
type Props = Omit<
  ComponentProps<typeof SharedWorkspaceSurfaceHeader>,
  "contentTabs"
> & { contentTabs: SidebarContentTab[] };
export function WorkspaceSurfaceHeader(props: Props) {
  return <SharedWorkspaceSurfaceHeader {...props} />;
}
