const DEFAULT_TITLE = "New Task";
const MAX_TITLE_WORDS = 5;

const FILLER_WORDS = new Set([
  "a",
  "an",
  "and",
  "can",
  "could",
  "for",
  "i",
  "it",
  "me",
  "my",
  "our",
  "please",
  "the",
  "to",
  "you",
]);

const TECH_WORDS: Record<string, string> = {
  api: "API",
  css: "CSS",
  html: "HTML",
  llm: "LLM",
  ui: "UI",
  ux: "UX",
};

const ACTION_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bmake it pretty\b/i, ""],
  [/\bchat flashing\b/i, "fix chat flashing"],
  [/\btimeout\b/i, "timeout"],
  [/\blets?\s+upgrade\b/i, "upgrade"],
  [/\bcheck\s+(?:my|our)?\b/i, "improve"],
  [/\bclarify\b/i, "clarify"],
];

export function generateChatTitleFromPrompt(prompt: string): string {
  const normalized = normalizePrompt(prompt);
  if (!normalized) {
    return DEFAULT_TITLE;
  }

  const words = normalized
    .split(/\s+/)
    .map(cleanWord)
    .filter(isUsefulWord)
    .slice(0, MAX_TITLE_WORDS);

  if (words.length === 0) {
    return DEFAULT_TITLE;
  }

  return words.map(toTitleWord).join(" ");
}

function normalizePrompt(prompt: string): string {
  const withoutFiles = prompt
    .replace(/@[^\s]+/g, " ")
    .replace(/\b(?:[\w.-]+\/)+[\w.-]+\b/g, " ")
    .replace(/\b[\w-]+\.(?:tsx?|jsx?|css|md|json|sql)\b/gi, " ");

  return ACTION_REPLACEMENTS.reduce(
    (value, [pattern, replacement]) => value.replace(pattern, replacement),
    withoutFiles.trim().toLowerCase(),
  ).replace(/[^\w\s-]/g, " ");
}

function cleanWord(word: string): string {
  return word.replace(/^[-_]+|[-_]+$/g, "");
}

function isUsefulWord(word: string): boolean {
  return word.length > 1 && !FILLER_WORDS.has(word);
}

function toTitleWord(word: string): string {
  return TECH_WORDS[word] ?? `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`;
}
