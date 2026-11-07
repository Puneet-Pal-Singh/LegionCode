import { SharedSettingsDialog } from "@legioncode/client-ui";
import { useProviderStore } from "../../hooks/useProviderStore.js";
import type { SettingsSection } from "../../lib/settings-dialog-events.js";
import { resolveWebProviderProductPolicy } from "../../lib/provider-product-policy";
import { canShowProviderInPrimaryUi } from "@repo/shared-types";
import type { HookSettingsAuditReadModel } from "@legioncode/sdk";
import { providerSettingsAdapter } from "../provider/providerSettingsAdapter";
import { ComposerSettingsSection } from "./ComposerSettingsSection";
import { ArchivedChatsSettings } from "./ArchivedChatsSettings";
import { HooksSettingsPanel } from "./HooksSettingsPanel";
const policy = resolveWebProviderProductPolicy();
const isProviderVisible = (providerId: string) =>
  canShowProviderInPrimaryUi(policy, providerId);
interface SettingsDialogProps {
  isOpen: boolean;
  runId?: string;
  workspaceId?: string | null;
  hookAudits?: readonly HookSettingsAuditReadModel[];
  initialSection?: SettingsSection;
  onUnarchiveSession?: (sessionId: string) => Promise<void>;
  onClose: () => void;
}
export function SettingsDialog({
  isOpen,
  runId,
  workspaceId = null,
  hookAudits = [],
  initialSection = "general",
  onUnarchiveSession = async () => undefined,
  onClose,
}: SettingsDialogProps) {
  const store = useProviderStore(runId, undefined, workspaceId);
  return (
    <SharedSettingsDialog
      isOpen={isOpen}
      onClose={onClose}
      initialSection={initialSection}
      provider={providerSettingsAdapter(store)}
      isProviderVisible={isProviderVisible}
      composerSettings={<ComposerSettingsSection />}
      archivedContent={
        <ArchivedChatsSettings
          isActive
          onUnarchiveSession={onUnarchiveSession}
        />
      }
      hooksContent={
        <HooksSettingsPanel
          isActive
          workspaceId={workspaceId}
          audits={hookAudits}
        />
      }
    />
  );
}
