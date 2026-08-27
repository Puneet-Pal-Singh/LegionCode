<!--
Title: <type>(<scope>): <imperative summary>

Examples:
- feat(web): add composer model picker
- fix(runtime): enforce run isolation
- refactor(brain): extract lifecycle collaborators

Do not include private/internal IDs, links, file names, or paths.
-->

## Summary

<!-- Briefly describe the outcome of this PR. -->

## Why

<!-- What problem does this solve, and why is this approach appropriate? -->

## What changed

<!-- List the meaningful changes and deliberate exclusions. -->

-

Breaking changes: <!-- None, or describe the required migration. -->

Related public issues / PRs: <!-- N/A, or add links. -->

## Verification

<!-- Include focused tests, type checks, gates, and relevant manual/E2E evidence. -->

- [ ] Tests:
- [ ] Type / lint / build:
- [ ] Architecture or conformance gates:
- [ ] Manual or product-path verification:

## Risks and rollback

<!-- State meaningful risks and the safe rollback/recovery path. Write None when not applicable. -->

<details>
<summary>Architecture and lifecycle details (required only when applicable)</summary>

<!--
Complete this section for runtime, lifecycle, workflow, tools, approvals,
context, persistence, Git, execution backends, harnesses, SDKs, or client-state
changes. Otherwise write N/A. Keep answers concise and link architecture docs
when deeper explanation is needed.
-->

Coordination:

- Merge independence:
- Remaining integration:
- Temporary mechanism deletion criteria:

Canonical wiring:

- Product responsibility:
- Current owner(s):
- Canonical owner after change:
- Active producers migrated:
- Active consumers migrated:
- Code or path removed:
- Replacement for removed behavior:
- Remaining duplicate authority: <!-- Include owner and deletion trigger when applicable. -->
- Capability ownership ledger update: <!-- Updated row, or why ownership is unchanged. -->

Lifecycle evidence: <!-- Complete for lifecycle fixes; otherwise N/A. -->

- User-visible symptom:
- Full affected lifecycle:
- Canonical owner:
- Violated invariant:
- Architectural root cause:
- Duplicate authority or fallback removed:
- Boundary regression test:
- Lifecycle/conformance regression test:

</details>
