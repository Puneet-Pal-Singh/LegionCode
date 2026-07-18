const FALLBACK_TITLE = "New task";
const MAX_PREVIEW_WORDS = 5;

const FILLER_WORDS = new Set([
  "a",
  "an",
  "and",
  "can",
  "could",
  "for",
  "from",
  "help",
  "i",
  "it",
  "me",
  "my",
  "of",
  "please",
  "the",
  "this",
  "to",
  "with",
  "you",
]);

/** Builds a deterministic, safe display title without sending the prompt away. */
export function buildThreadTitlePreview(prompt: string): string {
  const words = sanitizePromptForTitle(prompt)
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}-]+$/gu, ""))
    .filter((word) => word.length > 1 && !FILLER_WORDS.has(word.toLowerCase()));
  const uniqueWords = Array.from(
    new Map(words.map((word) => [word.toLowerCase(), word])).values(),
  ).slice(0, MAX_PREVIEW_WORDS);

  if (uniqueWords.length === 0) {
    return FALLBACK_TITLE;
  }

  return uniqueWords
    .map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
    .join(" ")
    .slice(0, 80);
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
