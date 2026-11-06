import type { HarnessAdmissionSelection } from "@repo/platform-protocol";

/** Execution intent is explicit. Provider/model names never select a strategy. */
export function isDelegatedHarnessRoute(input: {
  readonly harnessSelection?: HarnessAdmissionSelection;
  readonly harnessMode?: string;
}): boolean {
  return (
    input.harnessSelection?.selection != null ||
    input.harnessMode === "delegated"
  );
}
