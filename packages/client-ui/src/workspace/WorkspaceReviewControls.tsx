import { motion } from "framer-motion";
import { FileDiff, PanelRight } from "lucide-react";
import type { Ref } from "react";

export function WorkspaceReviewControls({
  onReview,
  onToggleRightSidebar,
  toggleButtonRef,
}: {
  onReview?: () => void;
  onToggleRightSidebar?: () => void;
  toggleButtonRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <div className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-950/70 p-0.5">
      <motion.button
        onClick={onReview}
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
        disabled={!onReview}
        aria-label="Review"
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-zinc-400 transition-all hover:bg-zinc-900 hover:text-white disabled:cursor-not-allowed disabled:text-zinc-600 disabled:hover:bg-transparent"
        title={onReview ? "Open review panel" : "Review is not available yet"}
      >
        <FileDiff size={15} />
      </motion.button>
      <motion.button
        ref={toggleButtonRef}
        onClick={onToggleRightSidebar}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        disabled={!onToggleRightSidebar}
        aria-label="Toggle right sidebar"
        className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-900 hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-600 disabled:hover:bg-transparent"
        title="Toggle right sidebar"
      >
        <PanelRight size={17} />
      </motion.button>
    </div>
  );
}
