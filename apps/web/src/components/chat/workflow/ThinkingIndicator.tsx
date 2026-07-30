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
    <div className="py-1 text-sm" role="status">
      <span className="turn-lifecycle-shimmer">{label}</span>
    </div>
  );
}
