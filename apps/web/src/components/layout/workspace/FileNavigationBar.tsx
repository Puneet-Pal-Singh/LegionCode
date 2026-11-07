import { WorkspaceFileNavigationBar } from "@legioncode/client-ui";
import type { ComponentProps } from "react";
import { OpenDropdown } from "../../navigation/OpenDropdown";
type Props = Omit<
  ComponentProps<typeof WorkspaceFileNavigationBar>,
  "openActions"
> & { onOpenIde?: (ide: string) => void };
export function FileNavigationBar({ onOpenIde, ...props }: Props) {
  return (
    <WorkspaceFileNavigationBar
      {...props}
      openActions={<OpenDropdown onSelect={onOpenIde} />}
    />
  );
}
