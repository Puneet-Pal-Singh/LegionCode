export function redactUserFacingOutput(text: string): string {
  return text
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
}
