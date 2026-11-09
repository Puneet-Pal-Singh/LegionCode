import { PRODUCT_MODES, type ProductMode } from "@repo/shared-types";
import type { ComponentProps, ReactNode } from "react";
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

/** Keep the existing composer controls in one tree while narrow containers reflow. */
export function ChatComposerToolbar({
  addControl,
  modelPicker,
  permissionControl,
  providerQuota,
  actions,
}: {
  addControl: ReactNode;
  modelPicker: ReactNode;
  permissionControl: ReactNode;
  providerQuota: ReactNode;
  actions: ReactNode;
}) {
  return (
    <div className="mt-2 flex min-w-0 flex-wrap items-center justify-between gap-2 pt-2">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 sm:gap-2">
        <div className="flex min-w-0 max-w-full items-center gap-1.5 sm:gap-2">
          <div className="shrink-0">{addControl}</div>
          <div className="h-3.5 w-px shrink-0 bg-zinc-700/80" />
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5 sm:gap-2">{modelPicker}</div>
        </div>
        {permissionControl}
        {providerQuota}
      </div>
      <div className="flex max-w-full shrink-0 flex-wrap items-center justify-end gap-1.5">
        {actions}
      </div>
    </div>
  );
}
