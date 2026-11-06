import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const manifest = JSON.parse(
  readFileSync(
    new URL("../src/runtime-manifest.json", import.meta.url),
    "utf8",
  ),
);
const platform = `${process.platform}-${process.arch}`;
if (!Object.hasOwn(manifest.platforms, platform))
  throw new Error("No verified Codex binary/schema pin for this platform");
const pin = manifest.platforms[platform];

// Use an explicitly supplied executable. Never resolve an ambient CLI or credentials.
const binary = process.argv[2];
if (!binary)
  throw new Error(
    "Usage: node scripts/generate-protocol.mjs /absolute/path/to/codex",
  );
if (resolve(binary) !== binary)
  throw new Error("Codex executable must be absolute");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (digest(readFileSync(binary)) !== pin.binarySha256) {
  throw new Error("Executable does not match the pinned platform build");
}
if (
  execFileSync(binary, ["--version"], { encoding: "utf8" }).trim() !==
  `codex-cli ${manifest.version}`
) {
  throw new Error("Unexpected Codex version");
}
const scratch = mkdtempSync(join(tmpdir(), "legioncode-codex-schema-"));
const destination = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../src/server/protocol/generated",
);
try {
  const schemas = join(scratch, "schemas");
  const types = join(scratch, "types");
  execFileSync(binary, [
    "app-server",
    "generate-json-schema",
    "--out",
    schemas,
  ]);
  execFileSync(binary, ["app-server", "generate-ts", "--out", types]);
  if (
    digest(
      readFileSync(join(schemas, "codex_app_server_protocol.schemas.json")),
    ) !== manifest.schemaSha256
  ) {
    throw new Error("Generated schema does not match the pinned schema");
  }
  // Copy only the initialize/session/control types currently consumed, plus their imports.
  const seen = new Set();
  function copy(relative) {
    if (seen.has(relative)) return;
    seen.add(relative);
    const source = readFileSync(join(types, relative), "utf8");
    for (const match of source.matchAll(/from "([^"]+)"/g)) {
      const dependency = resolve(
        dirname(join(types, relative)),
        match[1] + ".ts",
      );
      if (!dependency.startsWith(types + "/"))
        throw new Error("Unexpected generated import");
      copy(dependency.slice(types.length + 1));
    }
    const output = join(destination, relative);
    mkdirSync(dirname(output), { recursive: true });
    // Mechanical NodeNext import spelling; declarations otherwise remain upstream output.
    writeFileSync(output, source.replace(/from "([^"]+)"/g, 'from "$1.js"'));
  }
  for (const name of [
    "RequestId",
    "InitializeParams",
    "InitializeResponse",
    "v2/ThreadStartParams",
    "v2/ThreadResumeParams",
    "v2/ThreadReadParams",
    "v2/TurnStartParams",
    "v2/TurnSteerParams",
    "v2/TurnInterruptParams",
    "v2/ToolRequestUserInputParams",
    "v2/ToolRequestUserInputResponse",
  ])
    copy(name + ".ts");
  writeFileSync(
    join(destination, "JSONRPCMessage.schema.json"),
    readFileSync(join(schemas, "JSONRPCMessage.json")),
  );
  console.log(
    `Generated ${seen.size} pinned TypeScript files and JSON-RPC schema`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
