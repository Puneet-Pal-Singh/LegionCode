const LEAKED_INTERNAL_PREFACE_PATTERNS = [
  /^the user (said|asked|requested|wants|is greeting)\b/i,
  /^this is (?:a|an)\b/i,
  /^i should (?:check|inspect|review|find|get|start|respond|ask|run|switch|use|continue|determine|verify|summarize|fix|implement)\b/i,
  /^i need to (?:check|inspect|review|find|get|start|respond|ask|run|switch|use|continue|determine|verify|summarize|fix|implement)\b/i,
  /^first,?\s+i(?:'ll| will| need to)\b/i,
  /^(?:the )?current branch is\b/i,
  /^usually,\s*prs?\b/i,
  /^wait[,!\s]/i,
];

export function sanitizeUserFacingOutput(text: string): string {
  const sanitized = text
    .replace(
      /\/home\/sandbox\/runs\/(?:\[run\]|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[^\s"']+/gi,
      "the workspace file",
    )
    .replace(
      /\/home\/sandbox\/runs\/(?:\[run\]|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi,
      "the workspace directory",
    )
    .replace(
      /(?:error:\s*)?cat:\s*(?:the workspace file|\[workspace-file\])\s*:?\s*no such file or directory/gi,
      "The requested file was not found in the current workspace.",
    )
    .replace(
      /(?:error:\s*)?cat:\s*(?:the workspace file|\[workspace-file\])\s*:?\s*is a directory/gi,
      "The requested path is a directory. Please provide a file path.",
    )
    .replace(/https?:\/\/internal(?:\/[^\s"']*)?/gi, "[internal-url]");

  return stripLeakedInternalPreface(sanitized);
}

function stripLeakedInternalPreface(text: string): string {
  let remaining = text.trim();
  let removedAny = false;

  while (remaining.length > 0) {
    remaining = stripOrphanPunctuationBeforeInternalPreface(remaining);
    const sentence = readLeadingSentence(remaining);
    if (!sentence) {
      break;
    }
    if (!isLeakedInternalPrefaceSentence(sentence.value)) {
      break;
    }

    removedAny = true;
    remaining = sentence.rest.trimStart();
  }

  return removedAny ? remaining : text;
}

function stripOrphanPunctuationBeforeInternalPreface(text: string): string {
  const withoutPunctuation = text.replace(/^[.!?;:,\s]+/, "");
  if (
    withoutPunctuation !== text &&
    isLeakedInternalPrefaceSentence(withoutPunctuation)
  ) {
    return withoutPunctuation;
  }
  return text;
}

function readLeadingSentence(
  text: string,
): { value: string; rest: string } | null {
  const trimmed = text.trimStart();
  if (!trimmed) {
    return null;
  }

  const match = trimmed.match(
    /^([\s\S]*?[.!?](?:["'`)\]]+[.!?]?)?)(?:\s+|(?=[A-Z0-9]))([\s\S]*)$/,
  );
  if (!match) {
    return { value: trimmed, rest: "" };
  }

  return {
    value: (match[1] ?? "").trim(),
    rest: match[2] ?? "",
  };
}

function isLeakedInternalPrefaceSentence(sentence: string): boolean {
  const normalized = sentence.trim();
  if (!normalized) {
    return false;
  }

  return LEAKED_INTERNAL_PREFACE_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );
}
