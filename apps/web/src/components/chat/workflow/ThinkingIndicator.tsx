interface ThinkingIndicatorProps {
  label?: string;
}

/**
 * Presentation-only wait state. Runtime activity still comes exclusively from
 * canonical lifecycle replay. It remains mounted for the complete nonterminal
 * turn so tool-item transitions cannot restart or flash the shimmer.
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
