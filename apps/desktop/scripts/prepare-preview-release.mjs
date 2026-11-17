import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readNativePreviewReceipt } from "./preview-native-receipt.mjs";

const [directory, tag] = process.argv.slice(2);
const revision = process.env.GITHUB_SHA;
const repository = process.env.GITHUB_REPOSITORY;
const runId = process.env.GITHUB_RUN_ID;
if (!directory || !/^v[\d.]+-(?:desktop|native-mac)-preview\.[\w.-]+$/u.test(tag ?? "") ||
    !/^[a-f0-9]{40}$/u.test(revision ?? "") ||
    !/^[\w.-]+\/[\w.-]+$/u.test(repository ?? "") || !/^\d+$/u.test(runId ?? "")) {
  throw new Error("An exact source revision, preview tag and GitHub run are required");
}
const root = resolve(directory);
const files = (await readdir(root)).sort();
const receipt = await readNativePreviewReceipt(root);
const identity = `${receipt.version}-${receipt.architecture}`;
const pkg = `LegionCode-Native-Setup-Candidate-${receipt.architecture}.pkg`;
const expected = ["native-setup-candidate.json", pkg, `LegionCode Desktop-${identity}.dmg`, `LegionCode Desktop-${identity}.zip`];
if (files.length !== expected.length || expected.some((name) => !files.includes(name))) {
  throw new Error("Matching Mac archive, disk image, native setup and receipt are required");
}
const checksums = [];
const assets = [];
for (const name of files.filter((name) => name !== "native-setup-candidate.json")) {
  const path = join(root, name);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size === 0) throw new Error("Invalid Mac preview asset");
  // Use GitHub's normalized asset names in the checksum file too.
  const publishedName = name === pkg ? `LegionCode.Native.Setup-${identity}.pkg` : name.replaceAll(" ", ".");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const digest = hash.digest("hex");
  if (name === pkg && digest !== receipt.sha256) throw new Error("Native setup does not match its build receipt");
  checksums.push(`${digest}  ${publishedName}`);
  assets.push({ path, publishedName });
}
// Validate all files before publishing names. Never expose build-machine paths.
for (const asset of assets) await rename(asset.path, join(root, asset.publishedName));
const metadata = `${JSON.stringify({ ...receipt, sourceRevision: revision, workflowRunId: runId,
  packageFile: `LegionCode.Native.Setup-${identity}.pkg` }, null, 2)}\n`;
await writeFile(join(root, "native-setup.json"), metadata, { flag: "wx" });
checksums.push(`${createHash("sha256").update(metadata).digest("hex")}  native-setup.json`);
await unlink(join(root, "native-setup-candidate.json"));
await writeFile(join(root, "SHA256SUMS"), `${checksums.join("\n")}\n`, { flag: "wx" });
await writeFile(join(root, "release-notes.md"), `Unsigned Mac preview for manual evaluation.

Source: [${revision}](https://github.com/${repository}/commit/${revision}).
Package checks: [GitHub Actions run ${runId}](https://github.com/${repository}/actions/runs/${runId}).

Download the PKG for the protected Native application and execution service. The DMG and ZIP contain the standalone app preview. Match the architecture to your Mac. SHA256SUMS covers the exact uploaded files and native setup metadata.

The PKG is an initial-install candidate. Existing or partial Native installations are rejected; upgrades and rollback remain unqualified. After installation, open LegionCode Desktop and choose File → Set Up Local Execution to select Node/npm and run separate OS-authorized qualification. Docker is not required. Preserve existing profiles and credentials; use a disposable profile for verification. Older previews cannot read profiles after a non-Git folder grant has been saved.

This preview is unsigned and is not notarized. Updates are manual. It is not a completed beta or proof of the full Native Local or Native Cloud workflow. Host sandbox/subprocess qualification, complete hosted recovery/Stop, and installed end-to-end acceptance remain separate release gates. The existing restricted command backend remains until its replacement is proven.
`, { flag: "wx" });
