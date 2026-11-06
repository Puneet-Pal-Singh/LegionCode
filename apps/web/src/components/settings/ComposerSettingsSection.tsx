import { Switch } from "../ui/Switch.js";
import {
  updateComposerPreferences,
  useComposerPreferences,
} from "../../lib/composer-preferences";

export function ComposerSettingsSection(): React.ReactElement {
  const preferences = useComposerPreferences();

  return (
    <section
      className="ui-surface-section px-5 py-4"
      aria-labelledby="composer-settings-heading"
    >
      <div className="mb-4">
        <h2
          id="composer-settings-heading"
          className="text-sm font-medium text-zinc-100"
        >
          Composer
        </h2>
        <p className="mt-1 text-sm text-zinc-400">
          Choose how messages look and how follow-up prompts are handled.
        </p>
      </div>

      <div className="divide-y divide-zinc-800/80 rounded-xl border border-zinc-800/80 bg-zinc-950/45 px-4">
        <PreferenceSwitchRow
          label="Plain-text composer"
          description="Keep Markdown and links literal while composing. Turn this off to show a formatted preview below the editor."
          checked={preferences.plainTextComposer}
          onCheckedChange={(checked) =>
            updateComposerPreferences({ plainTextComposer: checked })
          }
        />

        <PreferenceSwitchRow
          label="Show context window usage"
          description="Show the usage ring and context details."
          checked={preferences.showContextWindowUsage}
          onCheckedChange={(checked) =>
            updateComposerPreferences({ showContextWindowUsage: checked })
          }
        />

        <div className="flex flex-col items-start gap-3 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
          <div className="min-w-0">
            <label
              htmlFor="composer-send-shortcut"
              className="block text-sm font-medium text-zinc-100"
            >
              Send shortcut
            </label>
            <p className="mt-1 max-w-xl text-xs leading-5 text-zinc-500">
              Sets normal sending while idle. During an active task, Enter
              queues, Cmd/Ctrl+Enter steers, and Shift+Enter adds a line.
            </p>
          </div>
          <select
            id="composer-send-shortcut"
            aria-label="Send shortcut"
            value={preferences.sendShortcut}
            onChange={(event) =>
              updateComposerPreferences({
                sendShortcut: event.currentTarget.value as
                  | "enter"
                  | "modifier_enter",
              })
            }
            className="h-9 w-full rounded-lg border border-zinc-700/90 bg-zinc-900 px-3 text-sm text-zinc-100 shadow-sm outline-none transition-colors hover:border-zinc-600 focus-visible:border-blue-400 focus-visible:ring-2 focus-visible:ring-blue-400/30 sm:w-48 sm:shrink-0"
          >
            <option value="enter">Enter sends</option>
            <option value="modifier_enter">Cmd/Ctrl+Enter sends</option>
          </select>
        </div>

        <div className="flex flex-col items-start gap-3 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
          <div className="min-w-0">
            <p className="text-sm font-medium text-zinc-100">
              Follow-up behavior
            </p>
            <p className="mt-1 max-w-xl text-xs leading-5 text-zinc-500">
              Sets the default composer button action while a task runs.
              Keyboard shortcuts stay Enter to queue and Cmd/Ctrl+Enter to
              steer.
            </p>
          </div>
          <div
            role="group"
            aria-label="Follow-up behavior"
            className="flex self-end rounded-lg border border-zinc-700/90 bg-zinc-900 p-1 shadow-sm sm:shrink-0 sm:self-auto"
          >
            <FollowUpOption
              label="Queue"
              selected={preferences.followUpBehavior === "queue"}
              onClick={() =>
                updateComposerPreferences({ followUpBehavior: "queue" })
              }
            />
            <FollowUpOption
              label="Steer"
              selected={preferences.followUpBehavior === "steer"}
              onClick={() =>
                updateComposerPreferences({ followUpBehavior: "steer" })
              }
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function PreferenceSwitchRow({
  label,
  description,
  checked,
  onCheckedChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}): React.ReactElement {
  return (
    <div className="flex flex-col items-start gap-3 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <p className="text-sm font-medium text-zinc-100">{label}</p>
        <p className="mt-1 max-w-xl text-xs leading-5 text-zinc-500">
          {description}
        </p>
      </div>
      <Switch
        label={label}
        checked={checked}
        onCheckedChange={onCheckedChange}
        className="self-end sm:self-auto"
      />
    </div>
  );
}

function FollowUpOption({
  label,
  selected,
  onClick,
}: {
  label: "Queue" | "Steer";
  selected: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70 ${
        selected
          ? "bg-zinc-700 text-zinc-50 shadow-sm"
          : "text-zinc-400 hover:text-zinc-100"
      }`}
    >
      {label}
    </button>
  );
}
