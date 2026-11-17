import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readNativePreviewReceipt } from "./preview-native-receipt.mjs";

const [directory, tag] = process.argv.slice(2);
const revision = process.env.GITHUB_SHA;
const repository = process.env.GITHUB_REPOSITORY;
const runId = process.env.GITHUB_RUN_ID;
const preview = /^v(\d+\.\d+\.\d+)-preview\.([1-9]\d*)(?![\s\S])/u.exec(tag ?? "");
if (!directory || !preview ||
    !/^[a-f0-9]{40}$/u.test(revision ?? "") ||
    !/^[\w.-]+\/[\w.-]+$/u.test(repository ?? "") || !/^\d+$/u.test(runId ?? "")) {
  throw new Error("An exact source revision, preview tag and GitHub run are required");
}
const root = resolve(directory);
const files = (await readdir(root)).sort();
const receipt = await readNativePreviewReceipt(root);
if (preview[1] !== receipt.version) throw new Error("Preview tag and packaged version differ");
const title = `LegionCode ${receipt.version} Preview ${preview[2]}`;
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
await writeFile(join(root, "release-title.txt"), `${title}\n`, { flag: "wx" });
await writeFile(join(root, "release-notes.md"), `**[Download for Mac — ${receipt.architecture === "arm64" ? "Apple Silicon (M1 or newer)" : "Intel"}](https://github.com/${repository}/releases/download/${tag}/LegionCode.Native.Setup-${identity}.pkg)**

1. Download and open the PKG installer.
2. Open LegionCode Desktop from Applications.
3. Choose File → Set Up Local Execution to select Node/npm and authorize local setup.

This is an unsigned preview for early evaluation. Native Local and Native Cloud are still being completed. Local execution does not require Docker.

The PKG installs the protected Native application and execution service. DMG and ZIP downloads contain the standalone app preview. GitHub's automatic Source code archives are for developers, not Mac installers.

<details>
<summary>Installation limits and technical details</summary>

Initial installation only: existing or partial Native installations are rejected. Upgrade/rollback and recovery remain unqualified. Preserve existing profiles and credentials and use a disposable profile for verification. Older previews cannot read profiles after a non-Git folder grant has been saved.

This app is unsigned and unnotarized. OS-authorized Native qualification, actual sandbox/subprocess cleanup, both installed Native workflows and hosted reconnect/Stop remain separate acceptance gates. The existing restricted backend stays until its replacement is proven.

Source: [${revision}](https://github.com/${repository}/commit/${revision}).
Package checks: [GitHub Actions run ${runId}](https://github.com/${repository}/actions/runs/${runId}).
SHA256SUMS covers the uploaded files and Native setup metadata.

</details>
`, { flag: "wx" });
