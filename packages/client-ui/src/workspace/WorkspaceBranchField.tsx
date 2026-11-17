import { useId } from "react";
import { GitBranch, LoaderCircle, RefreshCw } from "lucide-react";

/** Branch presentation extracted from the existing authorized project picker. */
export function WorkspaceBranchField({
  id,
  label = "Starting branch",
  state,
  value,
  branches,
  defaultBranch,
  disabled = false,
  onChange,
  onRetry,
}: {
  id?: string;
  label?: string;
  state: "loading" | "ready" | "error";
  value: string;
  branches: readonly { name: string }[];
  defaultBranch: string;
  disabled?: boolean;
  onChange: (branch: string) => void;
  onRetry: () => void;
}) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  return (
    <div className="min-w-0 flex-1">
      <label htmlFor={inputId} className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.12em] text-[#969daa]">
        {label}
      </label>
      {state === "loading" ? (
        <div role="status" className="flex h-10 items-center gap-2 text-xs text-[#969daa]">
          <LoaderCircle className="animate-spin" size={14} /> Loading branches…
        </div>
      ) : state === "error" ? (
        <button type="button" onClick={onRetry} disabled={disabled}
          className="flex h-10 items-center gap-2 text-xs text-[#e3a95c] disabled:opacity-40">
          <RefreshCw size={13} /> Retry branch access
        </button>
      ) : (
        <div className="relative">
          <GitBranch className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#969daa]" size={14} />
          <select id={inputId} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}
            className="h-10 w-full appearance-none rounded-md border border-[#343943] bg-[#111318] pl-9 pr-8 font-mono text-xs text-white focus:border-[#65b8ff] focus:outline-none disabled:opacity-40 sm:max-w-sm">
            {branches.map((branch) => (
              <option key={branch.name} value={branch.name}>
                {branch.name}{branch.name === defaultBranch ? " · default" : ""}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
