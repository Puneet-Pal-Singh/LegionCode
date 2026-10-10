import { getBrainHttpBase } from "../../lib/platform-endpoints";

const HYDRATED_IMAGE_PATH_PATTERN =
  /^\/api\/chat\/media\/[A-Za-z0-9_-]{16,128}\?session=[0-9a-fA-F-]{36}$/;
export function resolveHydratedChatImageSource(
  source: string,
): string | undefined {
  if (!HYDRATED_IMAGE_PATH_PATTERN.test(source)) return undefined;
  return `${getBrainHttpBase()}${source}`;
}
