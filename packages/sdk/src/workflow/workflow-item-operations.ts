import type { ItemId } from "@repo/platform-protocol";
import type {
  TurnWorkflowProjection,
  WorkflowItem,
} from "./turn-workflow-projection.js";

export function upsertItem(
  projection: TurnWorkflowProjection,
  item: WorkflowItem,
): TurnWorkflowProjection {
  const exists = projection.items.some(
    (candidate) => candidate.itemId === item.itemId,
  );
  return {
    ...projection,
    items: exists
      ? projection.items.map((candidate) =>
          candidate.itemId === item.itemId ? item : candidate,
        )
      : [...projection.items, item],
  };
}

export function updateItem(
  projection: TurnWorkflowProjection,
  itemId: ItemId,
  update: (item: WorkflowItem) => WorkflowItem,
): TurnWorkflowProjection {
  return {
    ...projection,
    items: projection.items.map((item) =>
      item.itemId === itemId ? update(item) : item,
    ),
  };
}
