type FileSelection = { source: "checkout" | "repository"; path: string };
const prefix = "legioncode:file-view:v1:";

/** A UI selection only. Every restoration performs a fresh owned read. */
export function readFileViewPreference(scope: string): FileSelection | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(prefix + scope) ?? "null");
    if (!value || typeof value !== "object" || !("source" in value) || !("path" in value)) return null;
    if ((value.source !== "checkout" && value.source !== "repository") || typeof value.path !== "string") return null;
    return { source: value.source, path: value.path };
  } catch { return null; }
}

export function rememberFileView(scope: string, selection: FileSelection | null): void {
  try { localStorage.setItem(prefix + scope, JSON.stringify(selection)); } catch { /* A preference cannot block an owned read. */ }
}
