import type { ActivityFeedRowViewModel } from "../../../services/activity/ActivityFeedViewModel.js";

interface ProviderInterruptionRowProps {
  row: Extract<ActivityFeedRowViewModel, { kind: "commentary" }>;
}

export function ProviderInterruptionRow({ row }: ProviderInterruptionRowProps) {
  const providerId = readMetadataString(row.metadata, "providerId");
  const modelId = readMetadataString(row.metadata, "modelId");
  const statusCode = readMetadataNumber(row.metadata, "statusCode");

  return (
    <div className="rounded border border-amber-500/30 bg-amber-950/20 px-3 py-2 text-sm text-amber-50">
      <div className="font-medium">The selected model stopped responding.</div>
      <div className="mt-1 text-xs leading-5 text-amber-100/75">
        This run was paused after bounded recovery. Technical details are kept
        out of the main answer.
      </div>
      {providerId || modelId || statusCode ? (
        <details className="mt-2 text-xs text-amber-100/70">
          <summary className="cursor-pointer">View details</summary>
          <dl className="mt-2 grid gap-1">
            {providerId ? <Detail label="Provider" value={providerId} /> : null}
            {modelId ? <Detail label="Model" value={modelId} /> : null}
            {statusCode ? (
              <Detail label="Status" value={String(statusCode)} />
            ) : null}
          </dl>
        </details>
      ) : null}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-16 text-amber-100/50">{label}</dt>
      <dd className="min-w-0 break-words font-mono text-amber-50/80">
        {value}
      </dd>
    </div>
  );
}

function readMetadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function readMetadataNumber(
  metadata: Record<string, unknown> | undefined,
  key: string,
): number | null {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
