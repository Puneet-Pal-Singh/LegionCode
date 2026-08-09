<!--
Title: <type>(<scope>): <imperative summary>

Examples:
- feat(web): add composer model picker
- fix(runtime): enforce run isolation
- refactor(brain): extract lifecycle collaborators

Do not include private/internal IDs, links, file names, or paths.
-->

## Summary

<!-- What changed, and why is it needed? Keep this to a few sentences. -->

## Scope

<!-- List the important changes and any deliberate exclusions or follow-up work. -->

-

Breaking changes: <!-- None, or describe the migration required. -->

Dependencies / merge order: <!-- None, or link public prerequisite PRs. -->

- Merge independence:
- Remaining integration:
- Temporary mechanism deletion criteria:

## Architecture and ownership

<!--
Required for runtime, lifecycle, workflow, tools, approvals, context,
persistence, Git, execution backends, harnesses, SDKs, and client-state changes.
For other PRs, write N/A.
-->

Canonical wiring: <!-- Complete for architecture-sensitive changes; otherwise N/A. -->

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

## Verification

<!-- Include focused tests, type checks, gates, and relevant manual/E2E evidence. -->

- [ ] Tests:
- [ ] Type / lint / build:
- [ ] Architecture or conformance gates:
- [ ] Manual or product-path verification:

## Risks and rollback

<!-- State meaningful risks and the safe rollback/recovery path. Write None when not applicable. -->

## Related

<!-- Public GitHub PRs/issues only. Write N/A when there are none. -->
