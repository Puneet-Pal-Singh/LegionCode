---
name: pr-workflow
description: Prepare, review, publish, and merge LegionCode pull requests with intentional scope, architecture evidence, and GitHub checks. Use when the user asks to create, inspect, review, update, or merge a pull request.
---

# Pull request workflow

Use `AGENTS.md` for repository policy and the `git-workflow` skill for Git
mutations. Do not create a branch, commit, push, PR, merge, or comment unless
the user requests that external action.

## Mandatory repository rules

Read and follow `local/Rules/GIT-RULES.md` and
`local/Rules/pr-strategy-checklist.md`. They require narrow PR scope, one owner
for high-churn files, explicit merge order for related work, no blanket staging,
and no history rewrite on shared or reviewed branches.

## Prepare

1. Inspect branch, status, diff, and the relevant lifecycle or package boundary.
2. Separate unrelated changes; do not fold them into the PR.
3. Run the smallest meaningful tests or checks at the changed risk boundary.
4. Check that the implementation has one canonical owner and did not add a
   compatibility path without a stated deletion trigger.

## Review

Review for the `AGENTS.md` architecture rules first: lifecycle ownership,
runtime/client boundaries, typed external input, approvals, artifacts, and Git
authority. Then review correctness, tests, and security. Report actionable
findings with file and line evidence; do not manufacture completion documents.

## Publish

Use the repository PR template. Include:

- objective and architecture decision;
- files changed;
- tests or gates run;
- risks and rollback/recovery notes when relevant;
- every retained fallback and its deletion trigger.

Wait for the user before beginning an AI-review polling loop or applying review
feedback. Treat GitHub checks as evidence, not as a substitute for review.

## Merge

Before publishing or merging, execute the conflict-prevention gate in
`local/Rules/GIT-RULES.md`. Confirm approvals, all required GitHub checks,
resolved code-change comments, a mergeable target branch, and the declared
scope. Prefer a merge commit for shared or reviewed branches. Do not delete
branches or perform post-merge cleanup without explicit user direction.
