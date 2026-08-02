import { isConcretePathInput } from "../contracts/index.js";

export function normalizeToolPath(input: string): string {
  const trimmed = input.trim().replace(/^['"`]+|['"`]+$/g, "");
  const withoutMention = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  const cleaned = withoutMention.replace(/[?!,;:]+$/g, "");
  return resolvePathAlias(cleaned);
}

export function normalizeWorkspacePath(input: string): string {
  const trimmed = input.trim().replace(/^['"`]+/, "");
  const cleaned = trimmed.replace(/['"`?!,;:]+$/g, "");
  return resolvePathAlias(cleaned);
}

export function validateToolPath(path: string): void {
  if (!isConcretePathInput(path)) {
    throw new Error("Task path must be a concrete non-empty file path");
  }
}

function resolvePathAlias(path: string): string {
  const aliases: Record<string, string> = {
    readme: "README.md",
    "readme.md": "README.md",
  };
  return aliases[path.toLowerCase()] ?? path;
}
