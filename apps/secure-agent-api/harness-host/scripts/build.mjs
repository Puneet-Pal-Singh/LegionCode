import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const hostDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const repositoryRoot = resolve(hostDirectory, "../../..");

/** Portable compilation only. Node 20 CI and macOS can compile the Node 22
 * runtime target without installing assets, starting SDKs, or creating an image.
 * The Linux package action calls this again into its own fresh runtime directory.
 */
export async function compileHost(outdir) {
  const result = await build({
    absWorkingDir: repositoryRoot,
    entryPoints: {
      host: join(hostDirectory, "main.ts"),
      "drivers/codex": "packages/harness-codex/src/server.ts",
      "drivers/claude": "packages/harness-claude/src/server.ts",
      "drivers/opencode": "packages/harness-opencode/src/server.ts",
    },
    bundle: true,
    splitting: true,
    platform: "node",
    target: "node22",
    format: "esm",
    outdir,
    outExtension: { ".js": ".mjs" },
    // Preserve the official SDK's relative/native asset lookup. Shared drivers
    // and OpenCode's typed Promise client are bundled from their final packages.
    external: ["@anthropic-ai/claude-agent-sdk"],
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
    metafile: true,
  });
  for (const output of Object.values(result.metafile.outputs)) {
    for (const dependency of output.imports) {
      if (dependency.external && dependency.path.startsWith("@repo/")) {
        throw new Error("Unpackaged workspace import in Node runtime");
      }
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const outdir = join(hostDirectory, "dist/compiled");
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });
  await compileHost(outdir);
  console.log(
    "Compiled cloud Node host and three shared drivers; no runtime assets packaged",
  );
}
