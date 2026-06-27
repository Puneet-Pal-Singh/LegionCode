import assert from "node:assert/strict";
import { test } from "node:test";
import { collectStagingCutoverViolations } from "./check-staging-cutover-readiness.mjs";

const completePackageJson = JSON.stringify({
  scripts: {
    "gate:golden-repo-to-pr": "bash scripts/gates/run-golden-repo-to-pr.sh",
    "gate:staging-cutover": "bash scripts/gates/run-staging-cutover.sh",
    "gate:rebuild-governance": "bash scripts/gates/run-rebuild-governance.sh",
    "gate:capability-preservation":
      "node scripts/gates/run-capability-preservation.mjs",
    "gate:runtime-conformance": "bash scripts/gate-runtime-conformance.sh",
    "gate:contract-conformance": "bash scripts/gates/run-contract-conformance.sh",
    "gate:dev-smoke": "bash scripts/gates/run-dev-smoke.sh",
    "check:boundaries": "bash scripts/check-import-boundaries.sh",
  },
});

const completeWorkflow = `
name: CI
jobs:
  golden-repo-to-pr:
    name: Golden Repo-To-PR Gate
    steps:
      - run: pnpm gate:golden-repo-to-pr
  staging-cutover:
    name: Staging Cutover Gate
    steps:
      - run: pnpm gate:staging-cutover
  build:
    needs: [golden-repo-to-pr, staging-cutover]
`;

test("accepts complete final Plan 023 gate wiring", async () => {
  const violations = await collectStagingCutoverViolations({
    packageJsonText: completePackageJson,
    workflowText: completeWorkflow,
  });
  assert.deepEqual(violations, []);
});

test("fails closed when the golden gate is not wired", async () => {
  const violations = await collectStagingCutoverViolations({
    packageJsonText: JSON.stringify({ scripts: {} }),
    workflowText: "name: CI\n",
  });
  assert.ok(
    violations.some((violation) =>
      violation.includes('missing blocking script "gate:golden-repo-to-pr"'),
    ),
  );
  assert.ok(
    violations.some((violation) =>
      violation.includes('missing required marker "name: Golden Repo-To-PR Gate"'),
    ),
  );
});
