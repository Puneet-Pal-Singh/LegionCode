import type { ProviderModelOption } from "../../services/api/providerClient.js";
import { cn } from "../../lib/utils.js";
import { formatModelDisplayName } from "./modelDisplayName";

interface ModelPickerDetailsPanelProps {
  model: ProviderModelOption;
  providerName: string;
  side: "left" | "right";
}

/**
 * Metadata companion anchored to the model-picker surface. Keeping this panel
 * in the same positioning context prevents it from drifting when the composer
 * or viewport moves.
 */
export function ModelPickerDetailsPanel({
  model,
  providerName,
  side,
}: ModelPickerDetailsPanelProps) {
  const inputs = Object.entries(model.inputModalities ?? {})
    .filter(([, supported]) => supported)
    .map(([name]) => name)
    .join(", ");
  const reasoning = model.capabilities?.supportsReasoning
    ? "Allows reasoning"
    : model.capabilities?.supportsReasoning === false
      ? "No reasoning"
      : "Not published";

  return (
    <div
      data-testid="model-picker-details"
      data-model-picker-attachment={side}
      className={cn(
        "ui-surface-popover pointer-events-none absolute top-0 z-10 w-64 p-3 text-sm",
        side === "right" ? "left-full ml-2" : "right-full mr-2",
      )}
    >
      <dl className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-3 gap-y-1.5">
        <ModelDetail label="Model" value={formatModelDisplayName(model)} />
        <ModelDetail label="Provider" value={providerName} />
        <ModelDetail label="Inputs" value={inputs || "Not published"} />
        <ModelDetail label="Reasoning" value={reasoning} />
        <ModelDetail
          label="Context"
          value={model.contextWindow?.toLocaleString() ?? "Not published"}
        />
      </dl>
    </div>
  );
}

function ModelDetail({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-xs text-neutral-500">{label}</dt>
      <dd
        className="truncate text-right font-medium text-neutral-100"
        title={value}
      >
        {value}
      </dd>
    </>
  );
}
