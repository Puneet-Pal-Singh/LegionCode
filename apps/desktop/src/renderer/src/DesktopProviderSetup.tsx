import {
  SharedProviderDialog,
  type ProviderSettingsPort,
} from "@legioncode/client-ui";

export const desktopProviderRecovery = (message: string | null) => ({
  message: message ?? "Provider configuration is unavailable.",
  remediation:
    "Check the granted workspace and protected OS credential storage, then retry.",
});

/** Native settings supply the single protected-command projection; presentation is Web's. */
export function DesktopProviderSetup({
  provider,
  isOpen,
  onClose,
  variant,
}: {
  provider: ProviderSettingsPort;
  isOpen: boolean;
  onClose: () => void;
  variant: "connect-only" | "manage-models-only";
}) {
  return (
    <SharedProviderDialog
      isOpen={isOpen}
      onClose={onClose}
      variant={variant}
      provider={provider}
      recoveryAdvice={desktopProviderRecovery}
    />
  );
}
