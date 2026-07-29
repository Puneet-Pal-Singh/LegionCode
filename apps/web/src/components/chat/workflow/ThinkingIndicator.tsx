interface ThinkingIndicatorProps {
  label?: string;
}

/**
 * Presentation-only wait state. Runtime activity still comes exclusively from
 * canonical lifecycle replay; this indicator fills only the quiet interval
 * before the next canonical item arrives.
 */
export function ThinkingIndicator({
  label = "Thinking",
}: ThinkingIndicatorProps) {
  return (
    <div
      className="flex items-center gap-2 py-1 text-sm text-zinc-500"
      role="status"
    >
      <span
        aria-hidden="true"
        className="flex h-3 items-center gap-0.5 text-zinc-500"
      >
        {[0, 1, 2, 3, 4].map((index) => (
          <span
            key={index}
            className="h-1 w-0.5 rounded-full bg-current motion-safe:animate-pulse motion-reduce:animate-none"
            style={{
              animationDelay: `${index * 110}ms`,
              transform: `scaleY(${index === 2 ? 2.5 : index % 2 ? 1.8 : 1})`,
            }}
          />
        ))}
      </span>
      <span>{label}</span>
    </div>
  );
}
