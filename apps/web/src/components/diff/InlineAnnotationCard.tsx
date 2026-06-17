import { MessageSquareText } from "lucide-react";
import type { ReviewCommentDraft } from "../git/reviewComments";

interface InlineAnnotationCardProps {
  annotation: ReviewCommentDraft;
  onReply: () => void;
  onResolve: () => void;
}

export function InlineAnnotationCard({
  annotation,
  onReply,
  onResolve,
}: InlineAnnotationCardProps) {
  return (
    <div className="border-b border-zinc-900/80 bg-black px-6 py-5">
      <div className="mx-auto max-w-3xl rounded-2xl border border-red-500/30 bg-[#111112] p-4 shadow-[0_0_0_1px_rgba(239,68,68,0.08)]">
        <div className="flex items-start gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-800 text-xs font-semibold text-zinc-200">
            You
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-sm text-zinc-300">
              <span className="font-medium text-white">You</span>
              <span className="text-zinc-500">now</span>
            </div>
            <div className="mt-2 text-sm leading-6 text-zinc-200">
              {annotation.note}
            </div>
            <div className="mt-4 flex items-center gap-4 text-sm">
              <button
                type="button"
                onClick={onReply}
                className="inline-flex items-center gap-2 text-sky-300 transition-colors hover:text-sky-200"
              >
                <MessageSquareText size={14} />
                Add reply...
              </button>
              <button
                type="button"
                onClick={onResolve}
                className="text-sky-300 transition-colors hover:text-sky-200"
              >
                Resolve
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
