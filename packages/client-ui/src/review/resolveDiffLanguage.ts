const LANGUAGE_MAP: Record<string, string> = {
  cjs: "javascript",
  cpp: "cpp",
  css: "css",
  go: "go",
  htm: "html",
  html: "html",
  java: "java",
  js: "javascript",
  json: "json",
  jsx: "jsx",
  md: "markdown",
  mjs: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  sql: "sql",
  svg: "xml",
  ts: "typescript",
  tsx: "tsx",
  txt: "text",
  vue: "vue",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
};

export function resolveDiffLanguage(path: string | undefined): string {
  if (!path) {
    return "text";
  }

  const extension = path.split(".").pop()?.trim().toLowerCase() ?? "";
  if (!extension) {
    return "text";
  }

  return LANGUAGE_MAP[extension] ?? "text";
}
