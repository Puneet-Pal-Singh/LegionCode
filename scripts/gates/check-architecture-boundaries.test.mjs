import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { validateArchitecture } from "./check-architecture-boundaries.mjs";

test("accepts canonical package dependencies and app imports", async (context) => {
  const root = await createFixture(context);
  assert.deepEqual(await validateArchitecture(root), []);
});

test("rejects forbidden canonical package dependencies", async (context) => {
  const root = await createFixture(context);
  await writeManifest(
    root,
    "packages",
    "runtime-kernel",
    "@repo/runtime-kernel",
    {
      "@repo/git-service": "workspace:*",
    },
  );

  assert.match(
    (await validateArchitecture(root)).join("\n"),
    /runtime-kernel.*must not depend on @repo\/git-service/,
  );
});

test("rejects forbidden app imports", async (context) => {
  const root = await createFixture(context);
  await writeFile(
    join(root, "apps", "web", "src", "index.ts"),
    'import { RuntimeKernel } from "@repo/runtime-kernel";\n',
  );

  assert.match(
    (await validateArchitecture(root)).join("\n"),
    /@shadowbox\/web must not import @repo\/runtime-kernel/,
  );
});

test("rejects competing canonical authority declarations", async (context) => {
  const root = await createFixture(context);
  await writeFile(
    join(root, "packages", "persistence", "src", "duplicate.ts"),
    "export interface WorkspaceManifestRepository {}\n",
  );

  assert.match(
    (await validateArchitecture(root)).join("\n"),
    /WorkspaceManifestRepository is owned by packages\/workspace-core/,
  );
});

test("rejects app deep imports into package source", async (context) => {
  const root = await createFixture(context);
  await writeFile(
    join(root, "apps", "brain", "src", "index.ts"),
    'import { value } from "../../../packages/shared-types/src/index.js";\n',
  );

  assert.match(
    (await validateArchitecture(root)).join("\n"),
    /apps must import packages through public package exports/,
  );
});

test("ignores transient Vite timestamp modules", async (context) => {
  const root = await createFixture(context);
  await writeFile(
    join(root, "apps", "web", "vite.config.ts.timestamp-1234-abcdef.mjs"),
    "export class RuntimeKernel {}\n",
  );

  assert.deepEqual(await validateArchitecture(root), []);
});

async function createFixture(context) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "architecture-fixture-"));
  context.after(() => rm(fixtureRoot, { force: true, recursive: true }));

  for (const [name, dependencies] of Object.entries({
    "event-store": { "@repo/platform-protocol": "workspace:*" },
    "git-service": { "@repo/platform-protocol": "workspace:*" },
    "permission-policy": { "@repo/platform-protocol": "workspace:*" },
    persistence: {
      "@repo/event-store": "workspace:*",
      "@repo/platform-protocol": "workspace:*",
      "@repo/shared-types": "workspace:*",
    },
    "platform-client-sdk": {
      "@repo/platform-protocol": "workspace:*",
      "@repo/provider-core": "workspace:*",
      "@repo/shared-types": "workspace:*",
    },
    "platform-protocol": {},
    "runtime-kernel": {
      "@repo/event-store": "workspace:*",
      "@repo/platform-protocol": "workspace:*",
      "@repo/workspace-core": "workspace:*",
    },
    "worker-protocol": { "@repo/platform-protocol": "workspace:*" },
    "workspace-core": { "@repo/platform-protocol": "workspace:*" },
  })) {
    await writeManifest(
      fixtureRoot,
      "packages",
      name,
      `@repo/${name}`,
      dependencies,
    );
  }
  await writeSource(
    fixtureRoot,
    "packages/event-store/src/types.ts",
    "export interface EventStore {}",
  );
  await writeSource(
    fixtureRoot,
    "packages/git-service/src/types.ts",
    "export interface GitService {}",
  );
  await writeSource(
    fixtureRoot,
    "packages/runtime-kernel/src/RuntimeKernel.ts",
    "export class RuntimeKernel {}",
  );
  await writeSource(
    fixtureRoot,
    "packages/workspace-core/src/repository.ts",
    "export interface WorkspaceManifestRepository {}",
  );
  await writeManifest(fixtureRoot, "apps", "brain", "@shadowbox/brain", {});
  await writeManifest(
    fixtureRoot,
    "apps",
    "secure-agent-api",
    "@shadowbox/secure-agent-api",
    {},
  );
  await writeManifest(fixtureRoot, "apps", "web", "@shadowbox/web", {});
  return fixtureRoot;
}

async function writeManifest(root, collection, directory, name, dependencies) {
  const packageRoot = join(root, collection, directory);
  await mkdir(join(packageRoot, "src"), { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({ name, dependencies }),
  );
  await writeFile(join(packageRoot, "src", "index.ts"), "");
}

async function writeSource(root, path, source) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, source);
}
