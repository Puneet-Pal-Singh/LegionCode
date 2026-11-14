import { ArchivedChatsSettingsView } from "@legioncode/client-ui";
import { useArchivedSessions } from "../../hooks/useArchivedSessions";
interface ArchivedChatsSettingsProps {
  isActive: boolean;
  onUnarchiveSession: (sessionId: string) => Promise<void>;
}
export function ArchivedChatsSettings({
  isActive,
  onUnarchiveSession,
}: ArchivedChatsSettingsProps) {
  const state = useArchivedSessions(isActive);
  return (
    <ArchivedChatsSettingsView
      sessions={state.sessions}
      isLoading={state.isLoading}
      error={state.error}
      removeSession={state.removeSession}
      deleteSession={state.deleteSession}
      deleteAllSessions={state.deleteAllSessions}
      onUnarchiveSession={onUnarchiveSession}
    />
  );
}
