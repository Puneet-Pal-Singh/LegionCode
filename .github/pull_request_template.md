<!--
Title format (required):
<type>(<scope>): <imperative summary>

Examples:
- feat(web): add composer model picker popover
- fix(runtime): enforce runId isolation in harness adapter
- refactor(brain): extract run lifecycle collaborators

Type guide:
- feat = new behavior/capability
- fix = bug/regression correction
- refactor = structure change only (no behavior change)

Safety:
- Do not include internal IDs/references (SHA-*, internal plans, internal Linear-only links).
- Do not include internal/local file names or paths, especially from ignored/private directories.
-->

## Description

<!-- Provide a clear and concise description of what this PR does -->

## What was accomplished

## Why this change

## What changed?

<!-- Describe the changes made in this PR -->

## Breaking changes

<!-- If this PR contains breaking changes, describe them here -->

## Rebuild governance

Merge independence:

<!-- State whether this PR can merge independently into dev, or name its prerequisite PRs. -->

Remaining integration:

<!-- State what later PRs must still do. If none, write N/A. -->

Temporary mechanism deletion criteria:

<!-- For feature flags, report-only gates, migration aids, or temporary scaffolding, state owner and deletion criteria. If none, write N/A. -->

## Lifecycle-first bug-fix evidence

Lifecycle impact:

<!-- Write "None" only when this PR does not affect run, chat, approval, interruption, artifact, reload/replay, or git-status/diff lifecycle behavior. -->

User-visible symptom:

<!-- Required for lifecycle-affecting fixes. If not lifecycle-affecting, write N/A. -->

Full affected lifecycle:

<!-- Required for lifecycle-affecting fixes. -->

Canonical owner:

<!-- Required for lifecycle-affecting fixes. -->

Violated invariant:

<!-- Required for lifecycle-affecting fixes. -->

Architectural root cause:

<!-- Required for lifecycle-affecting fixes. -->

Duplicate authority or fallback removed:

<!-- Required for lifecycle-affecting fixes. -->

Boundary regression test:

<!-- Required for lifecycle-affecting fixes. -->

Lifecycle/conformance regression test:

<!-- Required for lifecycle-affecting fixes. -->

Deliberately deferred correction and deletion criteria:

<!-- If none, write N/A. -->

<!-- ## Verification -->

<!-- ## **Test Results** (code block)
   ```
   ✓ test-file.test.ts ({N} tests)
   ───────────────────────
   Total: {X}/{Y} tests PASSING ✅
   ```  -->

<!-- ## **Code Quality Metrics** (simple table)
   - TypeScript strict, zero `any`, Zod validation, etc. -->

## Related

<!-- Public GitHub PRs/issues only. If none, write N/A. -->
