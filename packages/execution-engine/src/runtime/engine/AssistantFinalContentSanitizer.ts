const INTERNAL_TAG_PATTERN =
  /<(analysis|thinking|reasoning|internal|tool_call|tool_result)\b[^>]*>[\s\S]*?<\/\1>/gi;

const FINAL_OUTPUT_CUE_PATTERN =
  /\b(?:final output|final answer|visible final response)\b\s*[:.-]?\s*/gi;
const DIRECT_ANSWER_LINE_PATTERN =
  /^\s*(?:[-*•]\s*)?direct answer\s*[:.-]\s*(.+)$/gim;

const LEAKED_REASONING_LINE_PATTERNS = [
  /^looking at the previous turn\b/i,
  /^user says\b/i,
  /^intent\b/i,
  /^context\b/i,
  /^current state\b/i,
  /^the user (?:is|asked|likely|wants|wrote|requested)\b/i,
  /^i (?:will|should|need to|don't need to) (?:simply |now |use |see |look |respond|avoid|make|check|inspect)/i,
  /^i (?:need to|should|cannot|can't|haven't|will first)\b/i,
  /^first,\s+i need\b/i,
  /^perhaps they\b/i,
  /^constraint\b/i,
  /^call to action\b/i,
  /^helpful details\b/i,
  /^tone\b/i,
  /^draft \d+\b/i,
  /^step \d+\b/i,
  /^self-correction\b/i,
  /^\*?wait\*?,?\s+i am the llm\b/i,
  /^answer directly\b/i,
  /^brief helpful details\b/i,
  /^natural\/friendly\b/i,
  /^no (?:robotic|fabrication)\b/i,
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
  const directAnswer = extractDirectAnswerLine(value);
  if (directAnswer) {
    return directAnswer;
  }

  const afterFinalCue = extractAfterFinalCue(value);
  if (afterFinalCue) {
    return afterFinalCue;
  }

  const withoutInlineLeadIn = stripKnownInlineLeadIn(value);
  if (withoutInlineLeadIn !== value) {
    return withoutInlineLeadIn;
  }

  const paragraphs = splitParagraphs(value);
  const visibleParagraphs = paragraphs.filter(
    (paragraph) => !isLeakedReasoningParagraph(paragraph),
  );
  if (visibleParagraphs.length > 0 && visibleParagraphs.length < paragraphs.length) {
    return visibleParagraphs.join("\n\n");
  }
  if (paragraphs.length > 0 && visibleParagraphs.length === 0) {
    return "";
  }

  return value;
}

function extractDirectAnswerLine(value: string): string | null {
  const matches = [...value.matchAll(DIRECT_ANSWER_LINE_PATTERN)];
  const lastMatch = matches.at(-1);
  const candidate = lastMatch?.[1]?.trim();
  if (!candidate) {
    return null;
  }
  return stripWrappingQuotes(candidate);
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
  const lines = paragraph
    .split("\n")
    .map((line) => stripLeadingListMarker(line.trim()))
    .filter((line) => line.length > 0);
  const firstLine = lines[0] ?? "";
  if (matchesLeakedReasoningLine(firstLine)) {
    return true;
  }

  const leakedLineCount = lines.filter(matchesLeakedReasoningLine).length;
  return leakedLineCount > 0 && leakedLineCount >= Math.ceil(lines.length / 2);
}

function stripKnownInlineLeadIn(value: string): string {
  return value
    .replace(/^I don't need to use any tools for this\.\s*/i, "")
    .replace(/^I do not need to use any tools for this\.\s*/i, "");
}

function matchesLeakedReasoningLine(line: string): boolean {
  return LEAKED_REASONING_LINE_PATTERNS.some((pattern) => pattern.test(line));
}

function stripLeadingListMarker(value: string): string {
  return value.replace(/^[-*•]\s+/, "");
}

function stripWrappingQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}
