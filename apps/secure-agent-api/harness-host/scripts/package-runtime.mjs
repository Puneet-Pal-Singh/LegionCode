import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  compileHost,
  hostDirectory as host,
  repositoryRoot as root,
} from "./build.mjs";
import { installRuntimeAssets } from "./runtime-assets.mjs";
import { stageNodeDependencies } from "./stage-node-dependencies.mjs";

// Build on the image's target platform. Never package a developer's ambient CLI/home.
if (
  process.platform !== "linux" ||
  process.arch !== "x64" ||
  !process.report.getReport().header.glibcVersionRuntime ||
  Number(process.versions.node.split(".")[0]) < 22
) {
  throw new Error(
    "Cloud harness packaging requires Linux x64 glibc and Node >=22",
  );
}
const dist = join(host, "dist");
const runtime = join(dist, "runtime");
const scratch = await mkdtemp(join(tmpdir(), "legion-harness-package-"));
const lock = await readFile(join(root, "pnpm-lock.yaml"));
try {
  // Validate installed packages against the exact lock without network resolution
  // or lifecycle scripts. Binary downloads below have their own integrity locks.
  execFileSync(
    "corepack",
    [
      "pnpm",
      "--filter",
      "@legioncode/cloud-harness-host...",
      "install",
      "--offline",
      "--frozen-lockfile",
      "--ignore-scripts",
    ],
    { cwd: root, stdio: "inherit" },
  );
  await rm(runtime, { recursive: true, force: true });
  await rm(join(dist, "runtime.tar"), { force: true });
  await mkdir(runtime, { recursive: true });
  await compileHost(runtime);

  if (!(await readFile(join(root, "pnpm-lock.yaml"))).equals(lock)) {
    throw new Error("Packaging changed the root lockfile");
  }
  await stageNodeDependencies({ root, runtime });
  await writeFile(
    join(runtime, "package.json"),
    JSON.stringify({ private: true, type: "module" }) + "\n",
  );
  await cp(join(host, "scripts/launch-runtime.mjs"), join(runtime, "main.mjs"));
  const assets = await installRuntimeAssets({ root, runtime, scratch });
  await writeFile(
    join(runtime, "runtime-assets.json"),
    JSON.stringify(
      {
        format: 1,
        platform: "linux-x64-glibc",
        nodeMajorMinimum: 22,
        pnpmLockSha256: createHash("sha256").update(lock).digest("hex"),
        execution: {
          user: "legion-harness",
          uid: 65532,
          gid: 65532,
          home: "/home/legion-harness",
          privateRoot: "/var/lib/legioncode/harness",
        },
        assets,
      },
      null,
      2,
    ) + "\n",
  );
  async function finalize(path) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      const target = relative(runtime, await realpath(path));
      if (
        target === ".." ||
        target.startsWith(`..${sep}`) ||
        isAbsolute(target)
      ) {
        throw new Error(
          "Runtime dependency link escapes the packaged artifact",
        );
      }
    } else if (info.isDirectory()) {
      await chmod(path, 0o755);
      for (const entry of (await readdir(path)).sort())
        await finalize(join(path, entry));
    } else if (info.isFile()) {
      // Official archives may use owner-only modes. Root-owned image assets
      // must remain readable/executable by the dedicated non-root identity.
      await chmod(path, info.mode & 0o111 ? 0o755 : 0o644);
    } else {
      throw new Error("Unsupported file type in packaged runtime");
    }
  }
  await finalize(runtime);
  // Docker's app context excludes node_modules. Ship a deterministic archive,
  // including the complete SDK production graph, instead of a lone JS file.
  execFileSync(
    "tar",
    [
      "--sort=name",
      "--mtime=@0",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "--format=gnu",
      "-cf",
      join(dist, "runtime.tar"),
      "-C",
      runtime,
      ".",
    ],
    { stdio: "inherit" },
  );
  console.log(
    "Packaged pinned cloud Node host, three shared drivers and native runtime assets",
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
