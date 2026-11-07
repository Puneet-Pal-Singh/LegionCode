import {
  SharedProviderDialog,
  type ProviderDialogProps,
} from "@legioncode/client-ui";
import { useProviderStore } from "../../hooks/useProviderStore.js";
import { getProviderRecoveryAdvice } from "../../lib/provider-recovery.js";
import { providerSettingsAdapter } from "./providerSettingsAdapter";
export type { ProviderDialogProps } from "@legioncode/client-ui";
export function ProviderDialog(props: ProviderDialogProps) {
  const store = useProviderStore();
  return (
    <SharedProviderDialog
      {...props}
      provider={providerSettingsAdapter(store)}
      recoveryAdvice={getProviderRecoveryAdvice}
    />
  );
}
