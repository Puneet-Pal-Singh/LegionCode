import { readFile } from "node:fs/promises";

const REQUIRED_ROOT_SCRIPTS = [
  "gate:golden-repo-to-pr",
  "gate:staging-cutover",
  "gate:rebuild-governance",
  "gate:capability-preservation",
  "gate:runtime-conformance",
  "gate:contract-conformance",
  "gate:dev-smoke",
  "check:boundaries",
];

const REQUIRED_CI_MARKERS = [
  "name: Golden Repo-To-PR Gate",
  "run: pnpm gate:golden-repo-to-pr",
  "name: Staging Cutover Gate",
  "run: pnpm gate:staging-cutover",
  "golden-repo-to-pr",
  "staging-cutover",
];

export async function collectStagingCutoverViolations({
  packageJsonText = null,
  workflowText = null,
} = {}) {
  const packageJson = JSON.parse(
    packageJsonText ?? (await readFile("package.json", "utf8")),
  );
  const workflow =
    workflowText ?? (await readFile(".github/workflows/ci.yaml", "utf8"));

  return [
    ...findMissingRootScripts(packageJson.scripts ?? {}),
    ...findMissingWorkflowMarkers(workflow),
  ];
}

function findMissingRootScripts(scripts) {
  return REQUIRED_ROOT_SCRIPTS.filter((script) => !scripts[script]).map(
    (script) =>
      `[gate:staging-cutover] package.json is missing blocking script "${script}".`,
  );
}

function findMissingWorkflowMarkers(workflow) {
  return REQUIRED_CI_MARKERS.filter((marker) => !workflow.includes(marker)).map(
    (marker) =>
      `[gate:staging-cutover] CI workflow is missing required marker "${marker}".`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations = await collectStagingCutoverViolations();
  if (violations.length > 0) {
    console.error(
      "[gate:staging-cutover] Plan 023 final cutover readiness failed:",
    );
    for (const violation of violations) console.error(`- ${violation}`);
    process.exit(1);
  }
  console.log(
    "[gate:staging-cutover] Final Plan 023 gate wiring is blocking and cutover-ready.",
  );
}
