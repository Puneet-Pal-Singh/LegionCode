import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  findFeatureFlags,
  hasLifecycleSensitiveChange,
  hasMigrationSensitiveChange,
  validateChangedPathGovernance,
  validateFeatureFlagMetadata,
  validatePullRequestMetadata,
  validateRebuildGovernance,
} from "./check-rebuild-governance.mjs";

test("accepts registered feature flags", async (context) => {
  const root = await createFixture(context);
  await writeSource(
    root,
    "apps/brain/src/index.ts",
    'env.FEATURE_FLAG_CLOUDFLARE_AGENTS_V1 === "true";\n',
  );

  assert.deepEqual(await validateRebuildGovernance(root), []);
});

test("rejects unregistered feature flags", async (context) => {
  const root = await createFixture(context);
  await writeSource(
    root,
    "apps/brain/src/index.ts",
    "env.FEATURE_FLAG_" + 'UNKNOWN_REBUILD_PATH === "true";\n',
  );

  assert.match(
    (await validateRebuildGovernance(root)).join("\n"),
    new RegExp("FEATURE_FLAG_" + "UNKNOWN_REBUILD_PATH is not registered"),
  );
});

test("ignores generated Wrangler build output", async (context) => {
  const root = await createFixture(context);
  await writeSource(
    root,
    "apps/brain/.wrangler/tmp/dev-test/index.js",
    "const FEATURE_FLAG_" + "UNKNOWN_GENERATED_BUNDLE = true;\n",
  );

  assert.deepEqual(await validateRebuildGovernance(root), []);
});

test("temporary feature flags require deletion criteria", () => {
  const violations = [];
  validateFeatureFlagMetadata(
    "FEATURE_FLAG_" + "TEMPORARY_WITHOUT_EXIT",
    {
      owner: "test",
      temporary: true,
      deletionCriteria: "",
    },
    violations,
  );
  assert.match(violations.join("\n"), /temporary feature flags require/);
});

test("detects lifecycle-sensitive paths", () => {
  assert.equal(
    hasLifecycleSensitiveChange([
      "packages/execution-engine/src/runtime/engine/RunEngine.ts",
    ]),
    true,
  );
  assert.equal(hasLifecycleSensitiveChange(["scripts/readme.md"]), false);
});

test("requires lifecycle metadata for lifecycle-sensitive changes", () => {
  const violations = [];
  validatePullRequestMetadata(
    {
      changedFiles: ["apps/web/src/components/chat/ChatInterface.tsx"],
      prBody: "## Description\nNo lifecycle details.\n",
    },
    violations,
  );

  assert.match(violations.join("\n"), /Lifecycle metadata is missing/);
});

test("accepts complete lifecycle metadata", () => {
  const violations = [];
  validatePullRequestMetadata(
    {
      changedFiles: ["apps/web/src/components/chat/ChatInterface.tsx"],
      prBody: completeLifecycleBody(),
    },
    violations,
  );

  assert.deepEqual(violations, []);
});

test("keeps general metadata report-only by default", () => {
  const violations = [];
  validatePullRequestMetadata(
    {
      changedFiles: ["scripts/gates/check-rebuild-governance.mjs"],
      metadataMode: "report-only",
      prBody: "## Description\nNo governance fields.\n",
    },
    violations,
  );

  assert.deepEqual(violations, []);
});

test("can promote general metadata validation to blocking", () => {
  const violations = [];
  validatePullRequestMetadata(
    {
      changedFiles: ["scripts/gates/check-rebuild-governance.mjs"],
      metadataMode: "blocking",
      prBody: "## Description\nNo governance fields.\n",
    },
    violations,
  );

  assert.match(violations.join("\n"), /PR metadata is missing/);
});

test("detects migration-sensitive paths", () => {
  assert.equal(
    hasMigrationSensitiveChange([
      "packages/persistence/src/migrations/0020-new-table.ts",
    ]),
    true,
  );
});

test("requires migration safety test changes for migration-sensitive edits", () => {
  const violations = [];
  validateChangedPathGovernance(
    ["packages/persistence/src/migrations/0020-new-table.ts"],
    violations,
  );

  assert.match(violations.join("\n"), /migration safety test update/);
});

test("accepts migration-sensitive edits with migration tests", () => {
  const violations = [];
  validateChangedPathGovernance(
    [
      "packages/persistence/src/migrations/0020-new-table.ts",
      "packages/persistence/src/migrations/PostgresMigrationRunner.test.ts",
    ],
    violations,
  );

  assert.deepEqual(violations, []);
});

test("finds feature flag tokens without duplicate reports", () => {
  assert.deepEqual(
    findFeatureFlags(
      "FEATURE_FLAG_CHAT_AGENTIC_LOOP_V1 FEATURE_FLAG_CHAT_AGENTIC_LOOP_V1",
    ),
    ["FEATURE_FLAG_CHAT_AGENTIC_LOOP_V1"],
  );
});

async function createFixture(context) {
  const root = await mkdtemp(join(tmpdir(), "rebuild-governance-fixture-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  for (const directory of ["apps", "packages", "scripts", ".github"]) {
    await mkdir(join(root, directory), { recursive: true });
  }
  return root;
}

async function writeSource(root, path, source) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, source);
}

function completeLifecycleBody() {
  return [
    "user-visible symptom: chat stalls",
    "full affected lifecycle: prompt submission to terminal settlement",
    "canonical owner: runtime kernel",
    "violated invariant: one terminal state",
    "architectural root cause: duplicate settlement authority",
    "duplicate authority or fallback removed: removed web guess",
    "boundary regression test: runtime boundary test",
    "lifecycle/conformance regression test: lifecycle conformance test",
  ].join("\n");
}
