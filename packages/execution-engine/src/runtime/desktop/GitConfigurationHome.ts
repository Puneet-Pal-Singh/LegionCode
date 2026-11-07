/** The host's Git config selector is not a directory authority. Git accepts
 * relative or missing paths; preserving the spelling also preserves fallback. */
export function gitConfigurationHome(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    Buffer.byteLength(value) > 4_096 ||
    Buffer.from(value, "utf8").toString("utf8") !== value
  ) {
    throw new Error("Trusted Git configuration selector is invalid");
  }
  return value;
}
