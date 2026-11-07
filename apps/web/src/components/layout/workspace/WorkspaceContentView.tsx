import { WorkspaceContentView as SharedWorkspaceContentView } from "@legioncode/client-ui";
import type { ComponentProps } from "react";
import { OpenDropdown } from "../../navigation/OpenDropdown";
type Props = Omit<
  ComponentProps<typeof SharedWorkspaceContentView>,
  "openActions"
> & { onOpenIde?: (ide: string) => void };
export function WorkspaceContentView({ onOpenIde, ...props }: Props) {
  return (
    <SharedWorkspaceContentView
      {...props}
      openActions={<OpenDropdown onSelect={onOpenIde} />}
    />
  );
}
