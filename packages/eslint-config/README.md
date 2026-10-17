# `@turbo/eslint-config`

Collection of internal eslint configurations.

The root `pnpm lint` command also blocks new test files and test registrations.
It compares changed JavaScript/TypeScript test sources with the PR base in CI
and `merge-base(origin/main, HEAD)` locally; missing CI baselines fail closed.
Registration identity is the `it`/`test` API and static title, including inline
`.each` data. Callback-body edits and removals are allowed; renaming a title is
treated as a new registration. Dynamically loaded `.each` data is not expanded.
The `@repo/eslint-config` package owns this PR-required check for changed test
sources; review it if repository test policy changes.
