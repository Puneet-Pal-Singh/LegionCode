import type { LocalTurnConfigurationOptions } from "@repo/platform-protocol";

export function LocalExecutionDetails({
  commandExecution,
}: {
  commandExecution?: LocalTurnConfigurationOptions["commandExecution"];
}): React.JSX.Element | null {
  const entries = (["plan", "build"] as const).flatMap((mode) => {
    const profile = commandExecution?.[mode];
    return profile === "unavailable" || profile === "single_executable_nofork"
      ? [{ mode, profile }]
      : [];
  });
  if (entries.length === 0) return null;

  return (
    <section aria-label="Local execution" className="px-1 pb-2">
      <h3 className="px-2.5 py-1.5 text-[11px] font-medium text-zinc-400">
        Local execution
      </h3>
      <dl className="space-y-2 px-2.5 text-xs">
        {entries.map(({ mode, profile }) => (
          <div key={mode}>
            <dt className="font-medium text-zinc-300">
              {mode === "plan" ? "Plan" : "Build"}
            </dt>
            <dd className="mt-0.5 text-zinc-400">
              {profile === "unavailable" ? "Commands unavailable" : "Single executable"}
              {profile === "single_executable_nofork" ? (
                <p className="mt-1 leading-relaxed">
                  Runs with your user account’s filesystem, network and local-service access.
                  Child processes and interactive terminals are unavailable.
                </p>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
