import { getBrainHttpBase } from "../../lib/platform-endpoints";

const HYDRATED_IMAGE_PATH_PATTERN =
  /^\/api\/chat\/media\/[A-Za-z0-9_-]{16,128}\?session=[0-9a-fA-F-]{36}$/;
const REDACTED_IMAGE_MARKER_PATTERN =
  /^\[Image attached: [^\r\n\]]+, image\/(?:png|jpeg|webp|gif), (?:\d+(?:\.\d+)? (?:B|KB|MB))\]$/;

export function resolveHydratedChatImageSource(
  source: string,
): string | undefined {
  if (!HYDRATED_IMAGE_PATH_PATTERN.test(source)) return undefined;
  return `${getBrainHttpBase()}${source}`;
}

export function stripRedactedImageMarkers(content: string): string {
  return content
    .split(/\r?\n/)
    .filter((line) => !REDACTED_IMAGE_MARKER_PATTERN.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
