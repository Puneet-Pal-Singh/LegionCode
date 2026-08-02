---
name: git-workflow
description: Safely inspect repository state, stage intentional files, create commits, and perform explicitly requested branch or remote Git operations in LegionCode. Use when the user asks for git status, staging, commits, branches, pushes, merges, or history.
---

# Git workflow

Follow the repository's `AGENTS.md` as the source of truth. Preserve unfamiliar
work: it belongs to the user or another agent until proven otherwise.

## Mandatory repository rules

Before branch, commit, push, pull-request, or merge work, read and follow both:

- `local/Rules/GIT-RULES.md`
- `local/Rules/pr-strategy-checklist.md`

Never push directly to `main`, use `git add -A` or `git add .`, create a
fallback/compatibility fix to bypass a conflict, or use `-X ours`/`-X theirs`
for runtime or business logic.

## Inspect first

Before any mutation, run `git status --short` and inspect the relevant diff. For
commit or publish work, also inspect the current branch and recent commits.

## Mutate only with authority

- Create or switch branches, alter worktrees or stashes, merge, rebase, push, or
  delete only when the user explicitly requests that operation.
- Never use destructive reset, checkout, clean, force push, or blanket staging.
- Stage exact paths only; never use `git add .` or `git add -A`.
- Keep commits atomic and use the conventional format required by `AGENTS.md`.

## Commit workflow

1. Confirm the intended files and exclude unrelated changes.
2. Run the smallest relevant validation.
3. Stage only the confirmed files, inspect the staged diff, and commit.
4. Report the commit hash and remaining uncommitted changes.

## Shared branches

Assume branches may be shared. Prefer merge over rebase after review or push.
If an operation would overwrite, discard, or re-order someone else's work, stop
and request direction.

## Publish, PR, and merge gate

Before pushing, opening a PR, or merging, execute the conflict-prevention gate
from `local/Rules/GIT-RULES.md`: fetch the remote, inspect status and upstream
divergence, and inspect `origin/main...HEAD` for overlap. Sync shared or
reviewed branches with `git pull --ff-only`; if it fails, resolve an explicit
merge and rerun relevant checks. A PR is merge-ready only when required GitHub
checks pass, required review comments are resolved, the branch is mergeable,
and the changed files match its declared scope.
