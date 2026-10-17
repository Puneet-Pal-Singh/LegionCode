import { sanitizePromptForTitle } from "./ThreadTitlePreview";

export const THREAD_TITLE_INPUT_MAX_CHARACTERS = 4_000;

/** Metadata is not the request. Bound after extraction so wrappers cannot crowd it out. */
export function buildThreadTitleInput(prompt: string): string {
  const request = prompt.replace(
    /<(environment_context|external_codex_apps_open_page|system-reminder)>[\s\S]*?<\/\1>/giu,
    " ",
  );
  return Array.from(
    sanitizePromptForTitle(request, { preserveFileNames: true }),
  )
    .slice(0, THREAD_TITLE_INPUT_MAX_CHARACTERS)
    .join("");
}
