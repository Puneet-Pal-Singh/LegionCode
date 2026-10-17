/**
 * Codex's public streaming status uses the latest nonempty summary line,
 * removing Markdown heading/bold markers. Only pass display-safe content here.
 * An unfinished bold heading waits for its closing marker before replacing
 * the previous usable line.
 */
export function visibleReasoningTitle(
  text: string | null | undefined,
): string | null {
  for (const source of (text ?? "").split("\n").reverse()) {
    let line = source.trim();
    if (!line || line.startsWith("<!--")) continue;
    line = line.replace(/^#+\s*/u, "");
    if (line.startsWith("**")) {
      const end = line.indexOf("**", 2);
      if (end < 0) continue;
      line = `${line.slice(2, end)}${line.slice(end + 2)}`;
    }
    const title = line.replace(/\s+/gu, " ").trim();
    if (title) return title;
  }
  return null;
}
