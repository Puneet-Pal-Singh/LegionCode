import type { LifecycleProjection } from "../../../services/lifecycle/LifecycleProjection.js";

export function LifecycleWorkflow({
  projection,
}: {
  projection: LifecycleProjection | null;
}) {
  const workflowItems = projection?.items.filter(
    (item) => item.kind !== "assistant_message" && item.kind !== "user_message",
  );
  if (!workflowItems || workflowItems.length === 0) return null;

  return (
    <section aria-label="Workflow" data-testid="lifecycle-workflow">
      {workflowItems.map((item) => (
        <div
          key={item.itemId}
          data-testid={`lifecycle-item-${item.itemId}`}
          data-kind={item.kind}
          data-status={item.status}
          className="border-b border-zinc-900/70 py-2 text-sm text-zinc-400"
        >
          <span className="mr-2 text-zinc-500">{item.kind}</span>
          <span>{item.text}</span>
        </div>
      ))}
    </section>
  );
}
