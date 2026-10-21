import { motion } from "framer-motion";
import { ArrowUp, Play, Square } from "lucide-react";
import type { ComposerPreferences } from "../../../lib/composer-preferences";
import type { ComposerDelivery } from "./composer-keyboard.js";

interface ComposerSubmitControlsProps {
  readonly isActive: boolean;
  readonly canSubmit: boolean;
  readonly canSendMessage: boolean;
  readonly canStop: boolean;
  readonly canResume?: boolean;
  readonly onResume?: () => void;
  readonly followUpAvailable: boolean;
  readonly preferences: Pick<
    ComposerPreferences,
    "sendShortcut" | "followUpBehavior"
  >;
  readonly modifierShortcutLabel: string;
  readonly onSend: () => void;
  readonly onFollowUp: (delivery: ComposerDelivery) => void;
  readonly onStop?: () => void;
}

export function ComposerSubmitControls({
  isActive,
  canSubmit,
  canSendMessage,
  canStop,
  canResume = false,
  onResume,
  followUpAvailable,
  preferences,
  modifierShortcutLabel,
  onSend,
  onFollowUp,
  onStop,
}: ComposerSubmitControlsProps) {
  if (isActive) {
    const behavior = preferences.followUpBehavior;
    const label =
      behavior === "queue" ? "Queue follow-up message" : "Steer active task";
    return (
      <div className="flex shrink-0 items-center gap-1.5">
        <motion.button
          type="button"
          onClick={() => onFollowUp(behavior)}
          disabled={!canSubmit || !followUpAvailable}
          aria-label={label}
          title={
            followUpAvailable
              ? `${label} · ${modifierShortcutLabel} to ${behavior === "queue" ? "steer" : "queue"}`
              : "Follow-up delivery is unavailable"
          }
          whileHover={{ scale: canSubmit && followUpAvailable ? 1.05 : 1 }}
          whileTap={{ scale: canSubmit && followUpAvailable ? 0.95 : 1 }}
          className={`p-1.5 rounded-full transition-all ${
            canSubmit && followUpAvailable
              ? "bg-white text-black hover:bg-zinc-200"
              : "bg-zinc-800 text-zinc-600 cursor-not-allowed"
          }`}
        >
          <ArrowUp size={16} />
        </motion.button>
        {canStop && onStop ? (
          <motion.button
            type="button"
            onClick={onStop}
            aria-label="Stop generation"
            title="Stop generation"
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            className="p-1.5 rounded-full bg-white text-black transition-all hover:bg-zinc-200"
          >
            <Square size={14} />
          </motion.button>
        ) : null}
      </div>
    );
  }

  const resume = !canSubmit && canResume && onResume !== undefined;
  const enabled = canSendMessage || resume;
  return (
    <motion.button
      type="button"
      onClick={resume ? onResume : onSend}
      disabled={!enabled}
      aria-label={resume ? "Resume interrupted turn" : "Send message"}
      title={
        resume
          ? "Resume interrupted turn"
          : `Send message · ${preferences.sendShortcut === "enter" ? "Enter" : modifierShortcutLabel}`
      }
      whileHover={{ scale: enabled ? 1.05 : 1 }}
      whileTap={{ scale: enabled ? 0.95 : 1 }}
      className={`p-1.5 rounded-full transition-all ${
        enabled
          ? "bg-white text-black hover:bg-zinc-200"
          : "bg-zinc-800 text-zinc-600 cursor-not-allowed"
      }`}
    >
      {resume ? <Play size={16} /> : <ArrowUp size={16} />}
    </motion.button>
  );
}
