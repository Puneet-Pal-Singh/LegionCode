export function resolveModelCommentary(visibleText: string): string | null {
  const modelCommentary = visibleText.trim();
  return modelCommentary || null;
}
