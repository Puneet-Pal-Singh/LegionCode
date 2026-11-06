# PR Strategy Checklist

Use this checklist to avoid overlapping PR conflicts and reduce merge churn.

## 1) Scope and Split

- [ ] Default to **one PR per feature stream**.
- [ ] Only split into multiple PRs when each PR has a clear, independent boundary.
- [ ] If splitting, use **stacked PRs** (PR2 targets PR1 branch, PR3 targets PR2 branch) or fully non-overlapping files.
- [ ] Assign one owner for high-churn files (for example: `ChatInputBar`, `ProviderDialog`, `ModelPickerPopover`) at a time.

## 2) Branching Rules

- [ ] Create one working branch per PR (`codex/<type>-<scope>-<intent>`).
- [ ] Keep branch purpose narrow; avoid mixing unrelated UI, runtime, and test refactors.
- [ ] Do not open parallel PRs touching the same component surface unless explicitly planned as stacked.

## 3) Before Opening a PR

- [ ] Sync branch with latest `main`.
- [ ] Run required checks locally (`lint`, `typecheck`, targeted tests).
- [ ] Confirm changed files are expected and intentional.
- [ ] Ensure PR title and description clearly state scope and exclusions.

## 4) When Multiple PRs Exist

- [ ] Define merge order up front (for example: `#109 -> #110 -> #111`).
- [ ] Merge next PR only after previous PR is merged and branch is refreshed with latest `main`.
- [ ] Re-run checks after conflict resolution.
- [ ] Avoid force-pushing rewritten history on shared/reviewed branches.

## 5) Conflict Prevention

- [ ] Minimize overlap in:
  - [ ] UI components
  - [ ] shared helpers/lib files
  - [ ] test files for the same component
- [ ] Extract shared helper work into an earlier foundation PR when needed.
- [ ] Land foundational refactors first, then behavior/UI PRs.

## 6) Merge Gate

- [ ] All required checks green.
- [ ] No unresolved review comments that require code changes.
- [ ] Branch is mergeable (no conflicts).
- [ ] If conflicts appear, merge/reconcile with latest `main`, re-test, then merge.

## 7) Fast Recovery Playbook

If PR-N becomes conflicting after PR-(N-1) merge:

1. `git checkout <pr-branch>`
2. `git fetch origin`
3. `git merge origin/main`
4. Resolve conflicts in favor of intended PR scope
5. Re-run checks
6. `git push`
7. Merge PR-N

## 8) Team Agreement (Recommended)

- [ ] One feature stream = one active PR unless explicitly approved split.
- [ ] Announce ownership of high-churn files before coding.
- [ ] Keep PRs short-lived; merge quickly to reduce drift.
