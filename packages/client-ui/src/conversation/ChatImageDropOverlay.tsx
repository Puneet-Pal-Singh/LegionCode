interface ChatImageDropOverlayProps {
  testId: string;
}

export function ChatImageDropOverlay({ testId }: ChatImageDropOverlayProps) {
  return (
    <div
      className="pointer-events-none absolute inset-1 z-20 flex items-center justify-center rounded-[inherit] border border-dashed border-cyan-300/90 bg-zinc-950/90 px-5 text-center shadow-[inset_0_0_0_1px_rgba(103,232,249,0.15)]"
      data-testid={testId}
      aria-hidden="true"
    >
      <div>
        <div className="text-sm font-medium text-zinc-100">
          Drop files to attach
        </div>
        <div className="mt-1 text-xs text-zinc-500">
          PNG, JPEG, WebP, or GIF · up to 4 images
        </div>
      </div>
    </div>
  );
}
