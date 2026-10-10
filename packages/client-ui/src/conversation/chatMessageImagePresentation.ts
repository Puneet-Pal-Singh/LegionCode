const REDACTED_IMAGE_MARKER_PATTERN =
  /^\[Image attached: [^\r\n\]]+, image\/(?:png|jpeg|webp|gif), (?:\d+(?:\.\d+)? (?:B|KB|MB))\]$/;

export function stripRedactedImageMarkers(content: string): string {
  return content
    .split(/\r?\n/)
    .filter((line) => !REDACTED_IMAGE_MARKER_PATTERN.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
