---
name: quality-gates
description: Design, add, remove, or troubleshoot LegionCode tests, CI checks, smoke tests, and quality gates. Use when changing GitHub Actions, package gate scripts, test tiers, required checks, or CI performance.
---

# Quality gates

Treat a gate as executable product knowledge, not a memorial to a past bug.
Use `AGENTS.md` as the architectural source of truth.

## Decide whether a gate belongs

Add automation only for a repeated failure, a high-severity invariant, or a
boundary that cannot be reviewed reliably. For every retained gate, state one
invariant, one owner, affected paths, execution tier, and deletion or review
trigger.

## Choose the tier

- **PR required:** fast, deterministic lint, type, boundary, contract, and
  changed-risk tests.
- **PR conditional:** focused end-to-end coverage when lifecycle-critical paths
  change.
- **Nightly/report-only:** broad, flaky, exploratory, or quarantined suites.
- **Deployment:** real environment smoke checks after deployment. Never call a
  local test a staging check.

## Keep gates composable

- One gate owns one test set; do not invoke one gate from another.
- Do not rerun workspace type checks inside conformance gates when CI has a
  dedicated type-check job.
- Do not repeat test suites in smoke, capability, release, and staging jobs.
- Run tests where risk lives; prefer affected-package tests over workspace-wide
  suites when they prove the invariant.
- Keep the aggregation job dependency-only; it must not rerun validation.

## Validate a CI change

Inspect workflow triggers, job dependencies, scripts, and package references.
Run the changed script or its smallest constituent checks locally, validate YAML,
and confirm no removed script remains referenced. Measure recent CI wall-clock
and runner-minutes before adding work. If a suite is non-blocking, give it an
owner and promotion or removal condition. When renaming or removing a required
job, update branch protection in the same change and verify the configured
required check remotely.
