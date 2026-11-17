import { ComposerSettingsSection as SharedComposerSettingsSection } from "@legioncode/client-ui";
import {
  updateComposerPreferences,
  useComposerPreferences,
} from "../../lib/composer-preferences";
export function ComposerSettingsSection() {
  const preferences = useComposerPreferences();
  return (
    <SharedComposerSettingsSection
      preferences={preferences}
      onChange={updateComposerPreferences}
    />
  );
}
