import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Read only the receipt from this workflow's native package artifact. */
export async function readNativePreviewReceipt(root) {
  const path = join(root, "native-setup-candidate.json");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size < 1 || stat.size > 4096) throw new Error("Invalid native setup receipt");
  const value = JSON.parse(await readFile(path, "utf8"));
  const hash = (input) => typeof input === "string" && input.length === 64 && /^[a-f0-9]{64}$/u.test(input);
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      typeof value.version !== "string" || !/^\d+(?:\.\d+){0,3}(?![\s\S])/u.test(value.version) ||
      !["arm64", "x64"].includes(value.architecture) || value.unsigned !== true ||
      value.qualification !== "not_performed" || !hash(value.sha256) ||
      !hash(value.sourceSnapshotSHA256) || !hash(value.installerSHA256) ||
      value.installedApp !== "/Library/Application Support/LegionCode/Applications/LegionCode Desktop.app") {
    throw new Error("Invalid native setup receipt");
  }
  return { version: value.version, architecture: value.architecture, unsigned: true,
    qualification: "not_performed", installedApp: value.installedApp, sha256: value.sha256,
    sourceSnapshotSHA256: value.sourceSnapshotSHA256, installerSHA256: value.installerSHA256 };
}
