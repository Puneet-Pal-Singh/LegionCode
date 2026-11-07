import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// Binary-only archive lock. These are exact official Linux x64 glibc releases;
// SDK/client transitive packages remain owned by the frozen root pnpm lock.
const openCode = Object.freeze({
  name: "@opencode/cli-linux-x64",
  version: "2.2.5",
  url: "https://registry.npmjs.org/@opencode/cli-linux-x64/-/cli-linux-x64-2.2.5.tgz",
  integrity:
    "sha512-BkHAfTqNsg/qphyHNrnH+DGkOxZsGjamNpM5DvwoEvz7ZAPNw8mEbMXGTCDOAH+/+40Eqeie6KNZBZZQwPCjaA==",
});
const hash = (bytes, algorithm = "sha256", encoding = "hex") =>
  createHash(algorithm).update(bytes).digest(encoding);
const json = async (file) => JSON.parse(await readFile(file, "utf8"));

async function unpack(pin, destination, scratch) {
  await mkdir(destination, { recursive: true });
  const archive = join(scratch, `${pin.name.replaceAll("/", "-")}.tgz`);
  execFileSync(
    "curl",
    [
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "--proto",
      "=https",
      "--proto-redir",
      "=https",
      "--max-time",
      "300",
      "--output",
      archive,
      pin.url,
    ],
    { stdio: "inherit" },
  );
  if (
    `sha512-${hash(await readFile(archive), "sha512", "base64")}` !==
    pin.integrity
  ) {
    throw new Error(`Runtime archive integrity mismatch: ${pin.name}`);
  }
  // Only a verified archive is extracted. Never execute npm package install scripts.
  execFileSync("tar", ["-xzf", archive, "--no-same-owner", "-C", destination], {
    stdio: "inherit",
  });
  const manifest = await json(join(destination, "package/package.json"));
  if (manifest.name !== pin.name || manifest.version !== pin.version) {
    throw new Error(`Runtime package identity mismatch: ${pin.name}`);
  }
  return join(destination, "package");
}

function packageDirectory(from, name) {
  // The SDK's native platform package exposes its manifest beside the executable.
  return createRequire(from).resolve(`${name}/package.json`);
}

export async function installRuntimeAssets({ root, runtime, scratch }) {
  const codex = await json(
    join(root, "packages/harness-codex/src/runtime-manifest.json"),
  );
  const codexPin = codex.platforms["linux-x64"];
  const nativeVersion = `${codex.version}-linux-x64`;
  if (
    codex.version !== "0.167.0" ||
    codexPin.npmPackage !== `@openai/codex@${nativeVersion}`
  ) {
    throw new Error("Unreviewed Codex runtime pin");
  }
  const codexPackage = await unpack(
    {
      name: "@openai/codex",
      version: nativeVersion,
      url: `https://registry.npmjs.org/@openai/codex/-/codex-${nativeVersion}.tgz`,
      integrity: codexPin.npmIntegrity,
    },
    join(scratch, "codex"),
    scratch,
  );
  const codexBinary = join(
    codexPackage,
    "vendor/x86_64-unknown-linux-musl/bin/codex",
  );
  if (hash(await readFile(codexBinary)) !== codexPin.binarySha256) {
    throw new Error(
      "Codex executable differs from the generated-schema runtime pin",
    );
  }
  await mkdir(join(runtime, "runtimes/codex"), { recursive: true });
  await cp(codexPackage, join(runtime, "runtimes/codex"), { recursive: true });

  const openCodeManifest = await json(
    join(root, "packages/harness-opencode/package.json"),
  );
  for (const name of [
    "@opencode/client",
    "@opencode/protocol",
    "@opencode/schema",
  ]) {
    if (openCodeManifest.dependencies[name] !== openCode.version) {
      throw new Error("OpenCode executable/client compatibility pin mismatch");
    }
  }
  const openCodePackage = await unpack(
    openCode,
    join(scratch, "opencode"),
    scratch,
  );
  await mkdir(join(runtime, "runtimes/opencode"), { recursive: true });
  await cp(openCodePackage, join(runtime, "runtimes/opencode"), {
    recursive: true,
  });

  const require = createRequire(join(runtime, "package.json"));
  const sdkEntry = require.resolve("@anthropic-ai/claude-agent-sdk");
  const sdkManifest = await json(join(dirname(sdkEntry), "package.json"));
  if (
    sdkManifest.version !== "0.3.318" ||
    sdkManifest.claudeCodeVersion !== "2.1.318"
  ) {
    throw new Error("Claude SDK/bundled CLI compatibility pin mismatch");
  }
  const platformManifest = packageDirectory(
    sdkEntry,
    "@anthropic-ai/claude-agent-sdk-linux-x64",
  );
  const platform = await json(platformManifest);
  if (platform.version !== sdkManifest.version)
    throw new Error("Claude native asset pin mismatch");
  const claudeBinary = join(dirname(platformManifest), "claude");
  const openCodeBinary = join(runtime, "runtimes/opencode/bin/opencode");
  for (const binary of [codexBinary, openCodeBinary, claudeBinary]) {
    if (!(await stat(binary)).isFile())
      throw new Error("Required native runtime asset missing");
  }
  await chmod(openCodeBinary, 0o755);
  console.log(
    `Installed Codex ${codex.version}, Claude SDK ${sdkManifest.version}/CLI ${sdkManifest.claudeCodeVersion}, OpenCode ${openCode.version}`,
  );
  return {
    codex: {
      version: codex.version,
      schemaSha256: codex.schemaSha256,
      binarySha256: codexPin.binarySha256,
      archiveIntegrity: codexPin.npmIntegrity,
      executable: "runtimes/codex/vendor/x86_64-unknown-linux-musl/bin/codex",
    },
    claude: {
      sdkVersion: sdkManifest.version,
      cliVersion: sdkManifest.claudeCodeVersion,
      platformPackage: platform.name,
      binarySha256: hash(await readFile(claudeBinary)),
    },
    opencode: {
      version: openCode.version,
      archiveIntegrity: openCode.integrity,
      binarySha256: hash(await readFile(openCodeBinary)),
      executable: "runtimes/opencode/bin/opencode",
    },
  };
}
