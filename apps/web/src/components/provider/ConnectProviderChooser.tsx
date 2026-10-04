import {
  ConnectProviderChooser as SharedConnectProviderChooser,
  type ConnectProviderChooserProps as SharedConnectProviderChooserProps,
} from "@legioncode/client-ui";
import {
  AXIS_PROVIDER_ID,
  canShowProviderInPrimaryUi,
  isLaunchSupportedProvider,
  type ProviderRegistryEntry,
} from "@repo/shared-types";
import { getProviderRecoveryAdvice } from "../../lib/provider-recovery.js";
import { resolveWebProviderProductPolicy } from "../../lib/provider-product-policy";
import type { ReactElement } from "react";

const WEB_PROVIDER_POLICY = resolveWebProviderProductPolicy();

export type ConnectProviderChooserProps = Omit<
  SharedConnectProviderChooserProps,
  "catalog" | "errorRecovery"
> & { catalog: ProviderRegistryEntry[] };

export function ConnectProviderChooser(
  props: ConnectProviderChooserProps,
): ReactElement {
  const catalog = props.catalog.filter(
    (entry) =>
      entry.providerId !== AXIS_PROVIDER_ID &&
      canShowProviderInPrimaryUi(WEB_PROVIDER_POLICY, entry.providerId) &&
      entry.authModes.includes("api_key") &&
      isLaunchSupportedProvider(entry),
  );
  const recovery = props.error ? getProviderRecoveryAdvice(props.error) : null;

  return (
    <SharedConnectProviderChooser
      {...props}
      catalog={catalog}
      errorRecovery={
        recovery
          ? { message: recovery.message, remediation: recovery.remediation }
          : null
      }
    />
  );
}
