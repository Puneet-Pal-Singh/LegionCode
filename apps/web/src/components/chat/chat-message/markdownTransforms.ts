export function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content.reduce((text, part) => {
    if (!part || typeof part !== "object") {
      return text;
    }

    const record = part as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    const value = typeof record.text === "string" ? record.text : "";
    return type === "reasoning" || type === "thinking" ? text : text + value;
  }, "");
}

export function visibleAssistantContent(content: string): string {
  const parsed = parseThinkingTags(content);
  return stripInternalSelfTalkPrefix(parsed.visibleContent).trim();
}

export function stripAssistantChangeCounts(content: string): string {
  return content.replace(/ \(\+\d+ -\d+\)/g, "");
}

export function shortenTextMentions(content: string): string {
  return content.replace(
    /(^|\s)@(?:"((?:\\.|[^"\\])*)"|([^\s]+))/g,
    (
      fullMatch: string,
      prefix: string,
      quotedToken?: string,
      plainToken?: string,
    ) => {
      const rawToken = quotedToken ?? plainToken ?? "";
      const normalizedToken = unescapeMentionToken(rawToken.trim());
      if (!normalizedToken) {
        return fullMatch;
      }

      const basename = normalizedToken.split("/").pop() ?? normalizedToken;
      return `${prefix}@${basename}`;
    },
  );
}

export function visitMarkdownTextNodes(
  node: unknown,
  transform: (value: string) => string,
): void {
  if (!node || typeof node !== "object") {
    return;
  }

  const candidate = node as {
    type?: unknown;
    value?: unknown;
    children?: unknown;
  };

  if (candidate.type === "text" && typeof candidate.value === "string") {
    candidate.value = transform(candidate.value);
  }

  if (Array.isArray(candidate.children)) {
    candidate.children.forEach((child) =>
      visitMarkdownTextNodes(child, transform),
    );
  }
}

export function parseThinkingTags(content: string): {
  visibleContent: string;
  thinkingBlocks: string[];
} {
  if (!content) {
    return { visibleContent: "", thinkingBlocks: [] };
  }

  const thinkingBlocks: string[] = [];
  const visibleContent = content.replace(
    /<(thinking|think)>([\s\S]*?)<\/\1>/gi,
    (_match: string, _tag: string, block: string) => {
      const trimmedBlock = block.trim();
      if (trimmedBlock) {
        thinkingBlocks.push(trimmedBlock);
      }
      return "";
    },
  );

  return {
    visibleContent: visibleContent.replace(/\n{3,}/g, "\n\n"),
    thinkingBlocks,
  };
}

function stripInternalSelfTalkPrefix(value: string): string {
  let remaining = value.trimStart();
  let removedAny = false;

  while (remaining) {
    const withoutPunctuation = remaining.replace(/^[.!?;:,\s]+/, "");
    if (
      withoutPunctuation !== remaining &&
      isInternalSelfTalkSentence(withoutPunctuation)
    ) {
      remaining = withoutPunctuation;
    }

    const sentence = readLeadingAssistantSentence(remaining);
    if (!sentence || !isInternalSelfTalkSentence(sentence.value)) {
      break;
    }
    removedAny = true;
    remaining = sentence.rest.trimStart();
  }

  return removedAny ? remaining : value;
}

function readLeadingAssistantSentence(
  value: string,
): { value: string; rest: string } | null {
  const match = value.match(
    /^([\s\S]*?[.!?](?:["'`)\]]+[.!?]?)?)(?:\s+|(?=[A-Z0-9]))([\s\S]*)$/,
  );
  if (!match) {
    return value.trim() ? { value: value.trim(), rest: "" } : null;
  }
  return { value: (match[1] ?? "").trim(), rest: match[2] ?? "" };
}

function isInternalSelfTalkSentence(value: string): boolean {
  return [
    /^the user (?:is asking|asked|wants|requested|is greeting)\b/i,
    /^this is (?:a|an)\b/i,
    /^i should (?:check|inspect|review|find|get|start|respond|ask|run|switch|use|continue|determine|verify|summarize|fix|implement)\b/i,
    /^i need to (?:check|inspect|review|find|get|start|respond|ask|run|switch|use|continue|determine|verify|summarize|fix|implement)\b/i,
  ].some((pattern) => pattern.test(value.trim()));
}

function unescapeMentionToken(token: string): string {
  return token.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}
