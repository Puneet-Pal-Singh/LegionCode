const INTERNAL_TAG_PATTERN =
  /<(analysis|thinking|reasoning|internal|tool_call|tool_result)\b[^>]*>[\s\S]*?<\/\1>/gi;

const FINAL_OUTPUT_CUE_PATTERN =
  /\b(?:final output|final answer|visible final response)\b\s*[:.-]?\s*/gi;

const LEAKED_REASONING_LINE_PATTERNS = [
  /^looking at the previous turn\b/i,
  /^the user (?:is|asked|likely|wants|wrote|requested)\b/i,
  /^i (?:will|should|need to|don't need to) (?:simply |now |use |see |look |respond|avoid|make|check|inspect)/i,
  /^first,\s+i need\b/i,
  /^perhaps they\b/i,
];

export function sanitizeAssistantFinalContent(value: string): string {
  return removeReasoningLeadIn(stripHiddenAssistantMarkup(value))
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripHiddenAssistantMarkup(value: string): string {
  return value.replace(INTERNAL_TAG_PATTERN, "");
}

function removeReasoningLeadIn(value: string): string {
  const afterFinalCue = extractAfterFinalCue(value);
  if (afterFinalCue) {
    return afterFinalCue;
  }

  const paragraphs = splitParagraphs(value);
  const visibleParagraphs = paragraphs.filter(
    (paragraph) => !isLeakedReasoningParagraph(paragraph),
  );
  if (visibleParagraphs.length > 0 && visibleParagraphs.length < paragraphs.length) {
    return visibleParagraphs.join("\n\n");
  }

  return stripKnownInlineLeadIn(value);
}

function extractAfterFinalCue(value: string): string | null {
  const matches = [...value.matchAll(FINAL_OUTPUT_CUE_PATTERN)];
  const lastMatch = matches.at(-1);
  if (!lastMatch || lastMatch.index === undefined) {
    return null;
  }
  const start = lastMatch.index + lastMatch[0].length;
  const candidate = value.slice(start).trim();
  return candidate.length > 0 ? candidate : null;
}

function splitParagraphs(value: string): string[] {
  return value
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

function isLeakedReasoningParagraph(paragraph: string): boolean {
  const firstLine = paragraph.split("\n")[0]?.trim() ?? "";
  return LEAKED_REASONING_LINE_PATTERNS.some((pattern) =>
    pattern.test(firstLine),
  );
}

function stripKnownInlineLeadIn(value: string): string {
  return value
    .replace(/^I don't need to use any tools for this\.\s*/i, "")
    .replace(/^I do not need to use any tools for this\.\s*/i, "");
}
