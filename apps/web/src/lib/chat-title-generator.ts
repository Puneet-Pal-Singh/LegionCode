const DEFAULT_TITLE = "New Task";
const MAX_TITLE_WORDS = 5;

const FILLER_WORDS = new Set([
  "a",
  "an",
  "about",
  "and",
  "can",
  "could",
  "find",
  "for",
  "hi",
  "i",
  "it",
  "let",
  "lets",
  "me",
  "my",
  "our",
  "please",
  "tell",
  "the",
  "this",
  "to",
  "you",
]);

const TECH_WORDS: Record<string, string> = {
  api: "API",
  css: "CSS",
  html: "HTML",
  llm: "LLM",
  readme: "README",
  ui: "UI",
  ux: "UX",
};

const ACTION_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bcheck\s+(?:my|our)?\s+(.+?)\s+and\s+make it pretty\b/i, "improve $1"],
  [/\bmake\s+(?:my\s+)?(.+?)\s+prettier?\b/i, "improve $1"],
  [/\bmake it pretty\b/i, "improve"],
  [/\bchat flashing\b/i, "fix chat flashing"],
  [/\btimeout\b/i, "timeout"],
  [/\blets?\s+add\b/i, "add"],
  [/\blets?\s+upgrade\b/i, "upgrade"],
  [/\bcheck\s+(?:my|our)?\s+readme\b/i, "review project readme"],
  [/\bcheck\s+(?:my|our)?\b/i, "review"],
  [/\bclarify\b/i, "clarify"],
  [/\bimprovereadme\b/i, "improve readme"],
];

export function generateChatTitleFromPrompt(prompt: string): string {
  const normalized = normalizePrompt(prompt);
  if (!normalized) {
    return DEFAULT_TITLE;
  }

  const words = dedupeUsefulWords(
    normalized.split(/\s+/).map(cleanWord).filter(isUsefulWord),
  ).slice(0, MAX_TITLE_WORDS);

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
    withoutFiles.trim().toLowerCase().replace(/\breadme\b/g, "README"),
  ).replace(/[^\w\s-]/g, " ");
}

function cleanWord(word: string): string {
  return word.replace(/^[-_]+|[-_]+$/g, "");
}

function isUsefulWord(word: string): boolean {
  return word.length > 1 && !FILLER_WORDS.has(word);
}

function dedupeUsefulWords(words: string[]): string[] {
  const seen = new Set<string>();
  return words.filter((word) => {
    const key = word.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function toTitleWord(word: string): string {
  const normalized = word.toLowerCase();
  return (
    TECH_WORDS[normalized] ??
    `${word[0]?.toUpperCase() ?? ""}${word.slice(1).toLowerCase()}`
  );
}
