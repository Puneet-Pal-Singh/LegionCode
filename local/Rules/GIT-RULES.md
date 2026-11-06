# Git Rules

## Purpose

Reduce merge conflicts, review churn, and slow PR cycles by enforcing one clear git workflow.

This rule-set complements:

1. `local/Rules/pr-strategy-checklist.md`
2. `AGENTS.md` (Git + multi-agent safety)

## Core Invariants

1. `main` is protected and merge-only.
2. No direct push to `main`.
3. No `git add -A` or `git add .`.
4. No fallback/backward-compat quick fixes to bypass conflicts.
5. Shared/reviewed branches use `git pull --ff-only` by default.
6. Rebase is allowed only on private pre-PR branches.

## Branching Modes

## Mode A: Single PR (default)

Use one branch per scoped issue:

1. branch: `codex/<type>-<scope>-<intent>`
2. target: `main`
3. merge when checks + review are green.

## Mode B: PR Train (for multi-PR milestone)

Use when a milestone has 3+ tightly-related checkpoint PRs.

1. create one train branch: `codex/train-<milestone>`
2. all checkpoint branches start from train branch
3. checkpoint PRs target train branch (not `main`, not sibling branches)
4. final PR is train branch -> `main`
5. close train in 2-4 days max to avoid drift

Hard rule:

1. do not merge sibling branch A into sibling branch B for sync.
2. only sync from train branch or explicit `main` cut-point.

## Conflict Prevention Gate (mandatory before push/PR/merge)

Run:

```bash
git fetch origin
git status -sb
if git rev-parse --abbrev-ref --symbolic-full-name @{upstream} >/dev/null 2>&1; then
  git rev-list --left-right --count @{upstream}...HEAD
else
  echo "No upstream tracking branch yet; skipping divergence count."
fi
git diff --name-only origin/main...HEAD
```

Rules:

1. if shared/reviewed branch is behind, sync with `git pull --ff-only`
2. if `--ff-only` fails, do explicit merge conflict resolution
3. never use blanket `-X ours`/`-X theirs` on runtime/business files
4. if high-churn overlap exists, sequence ownership instead of parallel edits

## Merge Policy

1. Shared/reviewed branch:
   use merge or squash; preserve traceability.
2. Private pre-PR cleanup:
   rebase allowed.
3. Do not rewrite reviewed shared history.
4. Always re-run checks after conflict resolution.

## Review and Commit Hygiene

1. Batch review fixes in one pass where possible.
2. Keep one logical change per commit.
3. Do not mix rename/move with behavior changes in the same commit.
4. Keep PR scope narrow (single boundary/topic).

## Ownership for High-Churn Files

Before starting a PR train:

1. assign one owner per hotspot module (runtime core/router/policy files),
2. define merge order upfront,
3. avoid parallel ownership on the same file set.

## Exit Gate

A PR is merge-ready only when:

1. checks are green,
2. review comments requiring code changes are resolved,
3. branch is mergeable without hidden conflict debt,
4. changed files match declared scope.

