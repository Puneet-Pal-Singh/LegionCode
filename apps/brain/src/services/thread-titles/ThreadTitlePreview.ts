const FALLBACK_TITLE = "New task";
const MAX_PREVIEW_CHARACTERS = 8;

/** Builds a deterministic, safe display title without sending the prompt away. */
export function buildThreadTitlePreview(prompt: string): string {
  const safePrompt = sanitizePromptForTitle(prompt);
  if (!safePrompt) {
    return FALLBACK_TITLE;
  }
  const preview = Array.from(safePrompt)
    .slice(0, MAX_PREVIEW_CHARACTERS)
    .join("")
    .trimEnd();
  const title = `${preview[0]?.toUpperCase() ?? ""}${preview.slice(1)}…`;
  return title.slice(0, 80);
}

/**
 * Keeps sensitive-looking values and local paths out of title previews. This
 * is deliberately conservative because titles are persisted and displayed in
 * navigation.
 */
function sanitizePromptForTitle(prompt: string): string {
  return prompt
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/(?:api[_-]?key|token|authorization|password)\s*[:=]\s*\S+/gi, " ")
    .replace(/\b(?:sk|gh[opsu])_[A-Za-z0-9_-]+\b/g, " ")
    .replace(/@[^\s]+/g, " ")
    .replace(/(?:^|\s)(?:~\/|\/|[A-Za-z]:\\)[^\s]*/g, " ")
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
