import {
  SharedSettingsDialog,
  ComposerSettingsSection,
  HooksSettingsView,
  updateComposerPreferences,
  useComposerPreferences,
  HarnessConnectionSettings,
  type HarnessConnectionSettingsProps,
  type SettingsSection,
} from "@legioncode/client-ui";
import type { AppServerClient } from "@legioncode/sdk";
import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Thread } from "@repo/platform-protocol";
import type { DesktopBuildInfo } from "../../shared/desktop-api";
import { DesktopArchivedSettings } from "./DesktopArchivedSettings";
import { DesktopHostedAccount } from "./DesktopHostedAccount";
import type { DesktopHostedAccountControls } from "./useDesktopHostedAccount";
import { DesktopProviderSetup } from "./DesktopProviderSetup";
import { useDesktopProviderSettings } from "./useDesktopProviderSettings";

interface Props {
  open: boolean;
  onClose: () => void;
  client: AppServerClient | null;
  ready: boolean;
  harnessScope:
    | (NonNullable<HarnessConnectionSettingsProps["scope"]> & {
        client: AppServerClient;
        grantedAt: string;
      })
    | null;
  build: DesktopBuildInfo;
  hostedAccount?: DesktopHostedAccountControls;
  initialSection?: SettingsSection;
  providerDialogVariant?: "connect-only" | "manage-models-only" | null;
  onUnarchiveThread?: (threadId: Thread["id"]) => Promise<void>;
}

export function DesktopSettingsDialog({
  open,
  onClose,
  client,
  ready,
  harnessScope,
  initialSection = "general",
  providerDialogVariant,
  onUnarchiveThread,
  hostedAccount,
}: Props) {
  const provider = useDesktopProviderSettings(client, ready && open);
  const preferences = useComposerPreferences();
  const [harnessContainer] = useState(() => document.createElement("div"));
  const harnessSlot = useRef<HTMLDivElement | null>(null);
  const [harnessAttached, setHarnessAttached] = useState(false);
  const mountHarnessSettings = useCallback(
    (slot: HTMLDivElement | null) => {
      if (slot) {
        slot.appendChild(harnessContainer);
      } else if (harnessContainer.parentNode === harnessSlot.current) {
        harnessContainer.remove();
      }
      harnessSlot.current = slot;
      setHarnessAttached(Boolean(slot?.isConnected));
    },
    [harnessContainer],
  );
  const currentHarnessScope =
    ready && harnessScope?.client === client ? harnessScope : null;
  const harnessKey = JSON.stringify([
    currentHarnessScope?.workspaceId,
    currentHarnessScope?.environmentId,
    currentHarnessScope?.grantedAt,
  ]);
  return (
    <>
      {createPortal(
        <HarnessConnectionSettings
          key={harnessKey}
          client={currentHarnessScope?.client ?? null}
          scope={
            currentHarnessScope
              ? {
                  workspaceId: currentHarnessScope.workspaceId,
                  environmentId: currentHarnessScope.environmentId,
                }
              : null
          }
          placement="local"
          active={harnessAttached && open && ready && !providerDialogVariant}
        />,
        harnessContainer,
      )}
      {providerDialogVariant ? (
        <DesktopProviderSetup
          isOpen={open}
          onClose={onClose}
          variant={providerDialogVariant}
          provider={provider}
        />
      ) : (
        <SharedSettingsDialog
          isOpen={open}
          onClose={onClose}
          initialSection={initialSection}
          provider={provider}
          generalScopeDescription="Model visibility is saved for the granted workspace. Provider routes are explicit and protected credentials stay in OS-backed storage."
          composerSettings={
            <>
              <DesktopHostedAccount controls={hostedAccount} />
              <div ref={mountHarnessSettings} />
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
      )}
    </>
  );
}
