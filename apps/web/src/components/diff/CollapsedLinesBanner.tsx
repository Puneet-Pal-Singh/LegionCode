export function CollapsedLinesBanner({
  count,
  split = false,
}: {
  count: number;
  split?: boolean;
}) {
  return (
    <div
      className={`border-b border-zinc-900/80 bg-zinc-950/90 px-4 py-2 text-center font-mono text-xs text-zinc-500 ${
        split ? "col-span-2" : ""
      }`}
      aria-label={`${count} unmodified lines collapsed`}
    >
      {count} unmodified line{count === 1 ? "" : "s"}
    </div>
  );
}
