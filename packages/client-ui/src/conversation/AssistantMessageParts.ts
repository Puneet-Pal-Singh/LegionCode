export function getVisibleMessageContent(input: {
  role: string;
  content: unknown;
}): string {
  if (typeof input.content === "string") {
    return input.content.trim();
  }

  if (!Array.isArray(input.content)) {
    return "";
  }

  return input.content
    .map((part) => getVisiblePartText(part))
    .filter(Boolean)
    .join("")
    .trim();
}

function getVisiblePartText(part: unknown): string {
  if (!part || typeof part !== "object") {
    return "";
  }

  const record = part as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  if (type === "reasoning" || type === "thinking") {
    return "";
  }

  return typeof record.text === "string" ? record.text : "";
}
