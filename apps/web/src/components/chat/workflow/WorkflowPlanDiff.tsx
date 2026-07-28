import type { TurnWorkflowProjection } from "@repo/platform-client-sdk";

export function WorkflowPlanDiff({
  projection,
}: {
  projection: TurnWorkflowProjection;
}) {
  const plan = [...projection.items]
    .reverse()
    .find((item) => item.kind === "plan" && item.planSteps.length > 0);
  const files = projection.turnDiff?.files ?? [];
  if (!plan && files.length === 0) return null;

  const completedSteps =
    plan?.planSteps.filter((step) => step.status === "completed").length ?? 0;
  const additions = files.reduce(
    (total, file) => total + (file.additions ?? 0),
    0,
  );
  const deletions = files.reduce(
    (total, file) => total + (file.deletions ?? 0),
    0,
  );

  return (
    <div
      data-testid="canonical-plan-diff-chip"
      className="mb-3 text-xs text-zinc-500"
    >
      {plan ? `${completedSteps} / ${plan.planSteps.length} steps` : "Plan"}
      {files.length > 0
        ? ` · ${files.length} file${files.length === 1 ? "" : "s"} changed · +${additions} -${deletions}`
        : null}
    </div>
  );
}
