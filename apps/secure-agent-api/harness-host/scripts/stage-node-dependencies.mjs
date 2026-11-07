import { cp, mkdir, readFile, realpath, symlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";

async function resolvePackage(name, from) {
  for (const search of createRequire(join(from, "package.json")).resolve.paths(
    name,
  ) ?? []) {
    try {
      return await realpath(join(search, name));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return undefined;
}

function matches(values, value) {
  return (
    !values ||
    (!values.includes(`!${value}`) &&
      (!values.some((entry) => !entry.startsWith("!")) ||
        values.includes(value)))
  );
}

/** Copy the installed, frozen-lock graph without asking pnpm deploy to resolve
 * packages again. Each peer instance retains its own dependency links; no links
 * or workspace TypeScript escape the artifact. Do not flatten package versions.
 */
export async function stageNodeDependencies({ root, runtime }) {
  const copied = new Map();
  async function link(name, from, nodeModules, required = true) {
    const source = await resolvePackage(name, from);
    if (!source) {
      if (required)
        throw new Error(`Required locked runtime package missing: ${name}`);
      return;
    }
    const manifest = JSON.parse(
      await readFile(join(source, "package.json"), "utf8"),
    );
    if (
      !matches(manifest.os, "linux") ||
      !matches(manifest.cpu, "x64") ||
      !matches(manifest.libc, "glibc")
    ) {
      if (required)
        throw new Error(`Runtime package platform mismatch: ${name}`);
      return;
    }
    if (
      manifest.name.startsWith("@repo/") ||
      manifest.name.startsWith("@legioncode/")
    ) {
      throw new Error(
        "Workspace code must be bundled, not staged as TypeScript",
      );
    }
    let target = copied.get(source);
    if (!target) {
      const key = createHash("sha256")
        .update(relative(root, source))
        .digest("hex")
        .slice(0, 24);
      target = join(
        runtime,
        "node_modules/.store",
        key,
        "node_modules",
        manifest.name,
      );
      copied.set(source, target);
      await mkdir(dirname(target), { recursive: true });
      await cp(source, target, {
        recursive: true,
        filter: (path) => path !== join(source, "node_modules"),
      });
      const dependencies = {
        ...manifest.peerDependencies,
        ...manifest.dependencies,
        ...manifest.optionalDependencies,
      };
      for (const dependency of Object.keys(dependencies).sort()) {
        const optional =
          dependency in (manifest.optionalDependencies ?? {}) ||
          manifest.peerDependenciesMeta?.[dependency]?.optional === true;
        await link(dependency, source, join(target, "node_modules"), !optional);
      }
    }
    const destination = join(nodeModules, name);
    await mkdir(dirname(destination), { recursive: true });
    await symlink(relative(dirname(destination), target), destination, "dir");
  }
  await link(
    "@anthropic-ai/claude-agent-sdk",
    join(root, "packages/harness-claude"),
    join(runtime, "node_modules"),
  );
  console.log(`Staged ${copied.size} locked SDK/native/peer packages`);
}
