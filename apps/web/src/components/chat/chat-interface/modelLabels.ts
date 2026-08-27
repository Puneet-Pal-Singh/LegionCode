export function resolveModelLabel(
  modelId: string,
  providerModels: Record<string, Array<{ id: string; name: string }>>,
): string {
  for (const models of Object.values(providerModels)) {
    const matched = models.find((model) => model.id === modelId);
    if (matched?.name) {
      return matched.name;
    }
  }
  return summarizeModelId(modelId);
}

function summarizeModelId(modelId: string): string {
  const trimmed = modelId.trim();
  if (!trimmed) {
    return "Unknown model";
  }
  const withoutProvider = trimmed.includes("/")
    ? (trimmed.split("/").pop() ?? trimmed)
    : trimmed;
  return withoutProvider
    .replace(/\b(claude-(?:opus|sonnet|haiku)-\d+)-(\d+)(?=-|$)/gi, "$1.$2")
    .replace(/:free$/i, "")
    .replace(/-/g, " ");
}
