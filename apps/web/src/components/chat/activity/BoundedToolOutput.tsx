import { useState } from "react";

const OUTPUT_PREVIEW_LIMIT = 4_000;

interface BoundedToolOutputProps {
  output: string;
  sourceTruncated: boolean;
}

export function BoundedToolOutput({
  output,
  sourceTruncated,
}: BoundedToolOutputProps) {
  const [showFullOutput, setShowFullOutput] = useState(false);
  const needsExpansion = output.length > OUTPUT_PREVIEW_LIMIT;
  const visibleOutput =
    needsExpansion && !showFullOutput
      ? `${output.slice(0, OUTPUT_PREVIEW_LIMIT)}\n…`
      : output;

  if (!output && !sourceTruncated) {
    return null;
  }

  return (
    <div className="space-y-2">
      {visibleOutput ? (
        <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-6 text-zinc-200">
          {visibleOutput}
        </pre>
      ) : null}
      <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-500">
        {sourceTruncated ? (
          <span>The runtime retained a bounded output tail.</span>
        ) : null}
        {needsExpansion ? (
          <button
            type="button"
            className="font-medium text-zinc-300 hover:text-white"
            onClick={() => setShowFullOutput((current) => !current)}
          >
            {showFullOutput ? "Show less" : "Expand output"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
