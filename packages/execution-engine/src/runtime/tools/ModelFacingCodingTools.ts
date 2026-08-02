/**
 * Tools exposed to the model on the canonical coding path.
 *
 * `multi_edit` remains a registered backend contract while older persisted
 * calls can replay, but it is intentionally not model-facing. Cohesive edits
 * use one `apply_patch`, `write_file`, or uniquely-scoped `edit_file` call.
 */
export function isModelFacingCodingTool(toolName: string): boolean {
  return toolName !== "multi_edit";
}
