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
      if (!normalizedToken) return fullMatch;
      const basename = normalizedToken.split("/").pop() ?? normalizedToken;
      return `${prefix}@${basename}`;
    },
  );
}

export function visitMarkdownTextNodes(
  node: unknown,
  transform: (value: string) => string,
): void {
  if (!node || typeof node !== "object") return;
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

function unescapeMentionToken(token: string): string {
  return token.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}
