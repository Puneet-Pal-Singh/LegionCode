import { PRODUCT_MODES, type ProductMode } from "@repo/shared-types";
import type {
  ContextBudgetSnapshot,
  UsageCostSnapshot,
} from "@repo/platform-client-sdk";
import { ContextWindowIndicator } from "./ContextWindowIndicator";
import { PermissionModeControl } from "./PermissionModeControl";

interface ChatComposerPermissionControlProps {
  value?: ProductMode;
  onChange?: (mode: ProductMode) => void;
  disabled: boolean;
}

export function ChatComposerPermissionControl({
  value = PRODUCT_MODES.AUTO_FOR_SAFE,
  onChange,
  disabled,
}: ChatComposerPermissionControlProps) {
  return (
    <PermissionModeControl
      value={value}
      onChange={(mode) => onChange?.(mode)}
      disabled={disabled || !onChange}
      appearance="ghost"
    />
  );
}

interface ChatComposerContextControlProps {
  budget: ContextBudgetSnapshot | null;
  usage: UsageCostSnapshot | null;
  onCompact?: () => void;
  onOpenDetails?: () => void;
}

export function ChatComposerContextControl(
  props: ChatComposerContextControlProps,
) {
  return <ContextWindowIndicator {...props} compact />;
}
