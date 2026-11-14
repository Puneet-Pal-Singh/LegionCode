import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const [directory, tag] = process.argv.slice(2);
const revision = process.env.GITHUB_SHA;
const repository = process.env.GITHUB_REPOSITORY;
const runId = process.env.GITHUB_RUN_ID;
if (!directory || !/^v[\d.]+-desktop-preview\.[\w.-]+$/u.test(tag ?? "") ||
    !/^[a-f0-9]{40}$/u.test(revision ?? "") ||
    !/^[\w.-]+\/[\w.-]+$/u.test(repository ?? "") || !/^\d+$/u.test(runId ?? "")) {
  throw new Error("An exact source revision, preview tag and GitHub run are required");
}
const root = resolve(directory);
const files = (await readdir(root)).sort();
if (files.length < 2 || !files.some((name) => name.endsWith(".dmg")) ||
    !files.some((name) => name.endsWith(".zip"))) {
  throw new Error("The packaged Mac installer and archive are both required");
}
const checksums = [];
for (const name of files) {
  if (!/^LegionCode Desktop-[\d.]+-(?:arm64|x64)\.(?:dmg|zip)$/u.test(name)) {
    throw new Error("Unexpected Mac preview asset");
  }
  const path = join(root, name);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size === 0) throw new Error("Invalid Mac preview asset");
  // Use GitHub's normalized asset names in the checksum file too.
  const publishedName = name.replaceAll(" ", ".");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  checksums.push(`${hash.digest("hex")}  ${publishedName}`);
  await rename(path, join(root, publishedName));
}
await writeFile(join(root, "SHA256SUMS"), `${checksums.join("\n")}\n`, { flag: "wx" });
await writeFile(join(root, "release-notes.md"), `Unsigned Mac preview for manual evaluation.

Source: [${revision}](https://github.com/${repository}/commit/${revision}).
Package checks: [GitHub Actions run ${runId}](https://github.com/${repository}/actions/runs/${runId}).

Download the DMG to install, or the ZIP for the app archive. Match the architecture to your Mac. SHA256SUMS covers the exact uploaded files.

This preview is unsigned and is not notarized. Updates are manual. It is not a completed beta or proof of the full Native Local or Native Cloud workflow. Host sandbox/subprocess qualification, complete hosted recovery/Stop, and installed end-to-end acceptance remain separate release gates. The existing restricted command backend remains until its replacement is proven.
`, { flag: "wx" });
