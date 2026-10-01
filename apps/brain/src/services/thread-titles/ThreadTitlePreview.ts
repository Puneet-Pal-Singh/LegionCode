const FALLBACK_TITLE = "New task";
const MAX_PREVIEW_CHARACTERS = 50;

/** Builds a deterministic, safe display title without sending the prompt away. */
export function buildThreadTitlePreview(prompt: string): string {
  const safePrompt = sanitizePromptForTitle(prompt);
  if (!safePrompt) {
    return FALLBACK_TITLE;
  }
  const characters = Array.from(safePrompt);
  const preview = characters
    .slice(0, MAX_PREVIEW_CHARACTERS)
    .join("")
    .trimEnd();
  const title = `${preview[0]?.toUpperCase() ?? ""}${preview.slice(1)}${
    characters.length > MAX_PREVIEW_CHARACTERS ? "…" : ""
  }`;
  return title.slice(0, 80);
}

/**
 * Keeps sensitive-looking values and local paths out of title previews. This
 * is deliberately conservative because titles are persisted and displayed in
 * navigation.
 */
export function sanitizePromptForTitle(
  prompt: string,
  options: { preserveFileNames?: boolean } = {},
): string {
  return prompt
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/(?:api[_-]?key|token|authorization|password)\s*[:=]\s*\S+/gi, " ")
    .replace(/\bBearer\s+\S+/gi, " ")
    .replace(/\b(?:sk|gh[opsu])_[A-Za-z0-9_-]+\b/g, " ")
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, " ")
    .replace(/@[^\s]+/g, (value) =>
      options.preserveFileNames ? fileBasename(value.slice(1)) : " ",
    )
    .replace(/(?:^|\s)(?:~\/|\/|[A-Za-z]:\\)[^\s]*/g, (value) =>
      options.preserveFileNames ? ` ${fileBasename(value.trim())}` : " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function fileBasename(value: string): string {
  const basename = value.split(/[\\/]/u).at(-1) ?? "";
  return /^[\w.-]+\.[A-Za-z0-9]{1,12}$/u.test(basename) ? basename : " ";
}
