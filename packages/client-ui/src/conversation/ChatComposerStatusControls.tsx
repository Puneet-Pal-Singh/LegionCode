import { PRODUCT_MODES, type ProductMode } from "@repo/shared-types";
import type { ComponentProps } from "react";
import { ContextWindowIndicator } from "./ContextWindowIndicator.js";
import { PermissionModeControl } from "./PermissionModeControl.js";

interface ChatComposerPermissionControlProps {
  value?: ProductMode;
  availableModes?: readonly ProductMode[];
  environmentKind?: "hosted" | "local";
  onChange?: (mode: ProductMode) => void;
  disabled: boolean;
}

export function ChatComposerPermissionControl({
  value = PRODUCT_MODES.AUTO_FOR_SAFE,
  environmentKind,
  availableModes,
  onChange,
  disabled,
}: ChatComposerPermissionControlProps) {
  return (
    <PermissionModeControl
      value={value}
      availableModes={availableModes}
      environmentKind={environmentKind}
      onChange={(mode) => onChange?.(mode)}
      disabled={disabled || !onChange}
      appearance="ghost"
    />
  );
}

type ChatComposerContextControlProps = Pick<
  ComponentProps<typeof ContextWindowIndicator>,
  "budget" | "usage" | "onCompact" | "onOpenDetails"
>;

export function ChatComposerContextControl(
  props: ChatComposerContextControlProps,
) {
  return <ContextWindowIndicator {...props} compact />;
}
