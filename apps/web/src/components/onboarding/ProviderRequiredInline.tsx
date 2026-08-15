import { KeyRound } from "lucide-react";

interface ProviderRequiredInlineProps {
  onConnect: () => void;
}

export function ProviderRequiredInline({ onConnect }: ProviderRequiredInlineProps) {
  return (
    <div className="mt-3 flex flex-col gap-3 rounded-lg border border-[#343943] bg-[#111318] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <KeyRound size={16} className="shrink-0 text-[#e3a95c]" />
        <div>
          <p className="text-sm font-medium text-[#f2f4f7]">
            Connect a model provider to run your first task.
          </p>
          <p className="mt-0.5 text-xs text-[#969daa]">
            Provider keys stay in the existing secure credential flow.
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={onConnect}
        className="min-h-10 shrink-0 rounded-md border border-[#4a515d] px-3 text-xs font-semibold text-white transition hover:bg-[#171a20] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#65b8ff]"
      >
        Connect provider
      </button>
    </div>
  );
}
