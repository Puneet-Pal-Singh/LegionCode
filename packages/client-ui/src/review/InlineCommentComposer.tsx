import { useEffect, useRef, useState } from "react";

interface InlineCommentComposerProps {
  selectedCount: number;
  onAddAnnotation: (note: string) => void;
  onCancel: () => void;
}

export function InlineCommentComposer({
  selectedCount,
  onAddAnnotation,
  onCancel,
}: InlineCommentComposerProps) {
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handleSubmit = () => {
    const note = draft.trim();
    if (!note) {
      return;
    }
    onAddAnnotation(note);
    setDraft("");
  };

  return (
    <div className="border-b border-zinc-900/80 bg-sky-500/12 px-6 py-5">
      <div className="mx-auto max-w-3xl rounded-2xl border border-red-500/30 bg-[#111112] p-4 shadow-[0_0_0_1px_rgba(239,68,68,0.08)]">
        <div className="mb-3 flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-800 text-xs font-semibold text-zinc-200">
            You
          </div>
          <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">
            {selectedCount} selected row{selectedCount === 1 ? "" : "s"}
          </div>
        </div>
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Leave a comment"
          className="min-h-24 w-full rounded-xl border border-red-500/30 bg-black/70 px-4 py-3 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-red-400/50 focus:outline-none"
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              handleSubmit();
            }
          }}
        />
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!draft.trim()}
            className="rounded-lg bg-zinc-200 px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
          >
            Comment
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="text-sm text-zinc-500 transition-colors hover:text-zinc-300"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
