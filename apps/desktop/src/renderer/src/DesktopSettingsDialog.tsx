import {
  SharedSettingsDialog,
  ComposerSettingsSection,
  HooksSettingsView,
  updateComposerPreferences,
  useComposerPreferences,
  type SettingsSection,
} from "@legioncode/client-ui";
import type { AppServerClient } from "@legioncode/sdk";
import type { Thread } from "@repo/platform-protocol";
import type { DesktopBuildInfo } from "../../shared/desktop-api";
import { DesktopArchivedSettings } from "./DesktopArchivedSettings";
import { DesktopHostedAccount } from "./DesktopHostedAccount";
import { DesktopProviderSetup } from "./DesktopProviderSetup";
import { useDesktopProviderSettings } from "./useDesktopProviderSettings";

interface Props {
  open: boolean;
  onClose: () => void;
  client: AppServerClient | null;
  ready: boolean;
  build: DesktopBuildInfo;
  initialSection?: SettingsSection;
  providerDialogVariant?: "connect-only" | "manage-models-only" | null;
  onUnarchiveThread?: (threadId: Thread["id"]) => Promise<void>;
}

export function DesktopSettingsDialog({
  open,
  onClose,
  client,
  ready,
  initialSection = "general",
  providerDialogVariant,
  onUnarchiveThread,
}: Props) {
  const provider = useDesktopProviderSettings(client, ready && open);
  const preferences = useComposerPreferences();
  if (providerDialogVariant)
    return (
      <DesktopProviderSetup
        isOpen={open}
        onClose={onClose}
        variant={providerDialogVariant}
        provider={provider}
      />
    );
  return (
    <SharedSettingsDialog
      isOpen={open}
      onClose={onClose}
      initialSection={initialSection}
      provider={provider}
      generalScopeDescription="Model visibility is saved for the granted workspace. Provider routes are explicit and protected credentials stay in OS-backed storage."
      composerSettings={
        <>
          <DesktopHostedAccount />
          <ComposerSettingsSection
            preferences={preferences}
            onChange={updateComposerPreferences}
          />
        </>
      }
      archivedContent={
        <DesktopArchivedSettings
          client={client}
          ready={ready && open}
          onUnarchiveThread={onUnarchiveThread}
        />
      }
      hooksContent={
        <HooksSettingsView unavailableReason="Hook definition management is not available in this local environment. No hook has been enabled or executed by these settings." />
      }
    />
  );
}
