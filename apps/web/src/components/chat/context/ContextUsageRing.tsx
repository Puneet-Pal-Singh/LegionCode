import { cn } from "../../../lib/utils";

interface ContextUsageRingProps {
  percent: number | null;
  size?: number;
  strokeWidth?: number;
  className?: string;
}

export function ContextUsageRing({
  percent,
  size = 18,
  strokeWidth = 2,
  className,
}: ContextUsageRingProps) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const normalizedPercent = Math.min(100, Math.max(0, percent ?? 0));
  const dashOffset = circumference * (1 - normalizedPercent / 100);

  return (
    <svg
      aria-hidden="true"
      className={cn("shrink-0 -rotate-90", className)}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeOpacity={percent === null ? 0.45 : 0.24}
        strokeWidth={strokeWidth}
      />
      {percent !== null ? (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
        />
      ) : null}
    </svg>
  );
}
