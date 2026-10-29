import { useState } from "react";
import { motion } from "framer-motion";
import { ArrowUp, Play, Square } from "lucide-react";
import type { ComposerPreferences } from "./composer-keyboard.js";
import type { ComposerDelivery } from "./composer-keyboard.js";

interface ComposerSubmitControlsProps {
  readonly isActive: boolean;
  readonly canResume: boolean;
  readonly onResume?: () => Promise<boolean>;
  readonly canSubmit: boolean;
  readonly canSendMessage: boolean;
  readonly canStop: boolean;
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
  canResume,
  onResume,
  canSubmit,
  canSendMessage,
  canStop,
  followUpAvailable,
  preferences,
  modifierShortcutLabel,
  onSend,
  onFollowUp,
  onStop,
}: ComposerSubmitControlsProps) {
  const [resumePending, setResumePending] = useState(false);
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

  const resumeInSendSlot = canResume && onResume !== undefined;
  const enabled = resumeInSendSlot
    ? !resumePending
    : canSendMessage;

  return (
    <motion.button
      type="button"
      onClick={() => {
        if (resumeInSendSlot) {
          if (resumePending) return;
          setResumePending(true);
          void onResume().finally(() => setResumePending(false));
          return;
        }
        onSend();
      }}
      disabled={!enabled}
      aria-label={resumeInSendSlot ? "Resume interrupted turn" : "Send message"}
      title={
        resumeInSendSlot
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
      {resumeInSendSlot ? <Play size={16} fill="currentColor" /> : <ArrowUp size={16} />}
    </motion.button>
  );
}
