# 058 — Web-First Thin Client Extraction

Date: 2026-10-08 (Asia/Kolkata)
Status: Proposed for discussion; documentation only. No implementation,
branch changes, agent interruption, PR creation or merges authorized here.
Parent architecture: Plan 056. Desktop delivery: Plan 057 and its existing LLD.

Full-plan execution design: `LLD/058-web-first-thin-client-extraction.md`
(expanded 2026-10-10; covers every phase 058.0 through 058.4, not just PR 058.1).
Recommended integration base and PR target: `dev`, with one short-lived feature
branch per capability PR; no `dev2` or direct implementation on `dev`.

2026-11-06 independent-integration clarification: Plans 048/061 implement
Codex, Claude Agent and OpenCode v2 locally/in cloud without waiting for 058,
057, Native inference or another driver. They reuse current reviewed contracts
and wire their missing in-path capabilities through canonical owners. Coordinate
shared-file changes instead of making extraction a roadmap predecessor.
058's extraction scope and acceptance remain unchanged.

## 1. Decision to discuss

Use the working hosted Web product to extract reusable client behavior before
resuming unfinished Desktop native execution. Keep the merged Desktop work.
Do not rebuild the product, invent a new architecture, or move all Web files.

This is a proposed execution-order addendum to Plan 056, not a second competing
thin-client architecture or another Desktop completion plan. Until approved,
056 section 6.1 and 057 section 8 retain their current Desktop-first order.
Adoption must explicitly update those sections and the 057 LLD sequencing note.
Do not mark either parent plan complete as a result of adopting this document.

There are two different operations:

- **Extraction:** relocate existing reusable code, keep behavior, migrate its
  real callers, and remove the old implementation.
- **Authority cutover:** replace a browser-owned product decision with the
  existing server/runtime owner. This requires wiring and verification, not
  merely moving the same browser service into a package.

Moving React hooks, localStorage and direct hosted fetch calls wholesale into
the SDK is not a thin-client cutover. It only hides a thick client elsewhere.

## 2. Current baseline and limitations

The locally available `origin/dev` reference inspected during planning is
`2e9c652a` (merged PR #447). Refresh the remote before implementation; this is
not a claim about an independently verified latest remote revision.

On that baseline:

- `packages/sdk`, `packages/app-server` and `packages/client-ui` already exist.
  Do not recreate or rename them, or resurrect `platform-client-sdk`.
- Web and Desktop already share shell/workspace/sidebar/provider presentation.
- Workflow replay/projection and provider clients already have SDK owners.
- Web still contains conversation orchestration, session storage/reconciliation,
  history loading, review derivation and direct product HTTP calls.
- App Server has local services and a hosted handshake; do not assume every
  hosted session/workspace/provider/Turn operation is already exposed through it.
- Desktop 057.6C is unfinished and has uncommitted changes in its recovery
  worktree. Those changes are not an approved extraction baseline.
- The main checkout is on a different branch with unrelated dirty changes and
  conversation-durability work. Reconcile relevant incoming fixes before moving
  affected code; do not replace newer behavior with older `dev` copies.
- `architecture/RUNTIME-ARCHITECTURE.md`, referenced by AGENTS.md, was absent in
  the inspected checkout. Record that missing reference; do not invent its
  contents or silently bypass a required ownership decision.

Preserve all other worktrees and unfinished changes. Do not reset, discard,
cherry-pick or merge the unfinished 6C work merely to start this plan.

## 3. Ownership — use existing places

| Responsibility | Destination | What must not move there |
| --- | --- | --- |
| Boot, routes, hosted login, browser integration, UI preferences | `apps/web` | Canonical runtime or durable product-state authority |
| Reusable conversation/composer/workflow/review presentation and React bindings | `packages/client-ui` | Server policy, credentials, execution, direct Brain route knowledge |
| Typed client operations, replay, continuation, pure reusable read models | `packages/sdk` | React, localStorage, filesystem, inference or lifecycle policy |
| Canonical domain schemas and identities | `packages/platform-protocol` | Business logic or a second set of existing schemas |
| Reusable client-facing dispatch and service delegation | `packages/app-server` | Hosted tenancy/auth policy or local implementation forced into hosted execution |
| Hosted authentication, tenancy, existing services and composition | `apps/brain` | A second public App Server or lifecycle state machine |
| Turn/tool/approval/terminal decisions | Existing runtime kernel and execution owners | Browser-owned settlement or transport-driven success |

Use existing workspace, Git, provider and persistence owners behind the server.
No new Cloud folder, package family, DI framework, generic registry or base class.
Only add a directory when actual code in the current PR needs it.

Web remains a real React application: rendering, form validation, optimistic
presentation, focus, scroll, pending/error display and subscription cleanup are
legitimate client work. Thin does not mean no client logic.

Shared UI may use browser APIs for presentation; it may not depend on hosted
credentials, Web-only global contexts or cloud resource management. Host-specific
actions use small explicit props/callbacks, not a new universal host framework.

## 4. Scope and non-goals

In scope: the existing `/agents` product path: thread navigation, conversation,
composer, workflow, approval/input controls, provider/workspace selection, saved
history and completed review. Extract only their actual dependencies.

Out of scope: native local inference/tools, Electron packaging enhancements,
new harnesses/providers/sandboxes, cloud infrastructure relocation, account
pairing, cross-device sync, handoff, public SDK release and a visual redesign.
Full phone/tablet remediation remains Plan 056's responsive slices; preserve
existing responsive behavior here without claiming that matrix is complete.

Do not extract the whole application to another directory. Web-only login,
marketing, routes and browser glue do not need a shared home. Do not migrate
every settings surface or integration unless it blocks the named `/agents` path.

## 5. Delivery order

One row is a bounded capability stream, not permission for one enormous PR.
Split it into independently working PRs where necessary. Every PR keeps the
hosted Web journey usable and targets `dev` after execution is authorized.
Plans 039, 044, 045, 046 and 047 apply as per-slice gates, not blanket blockers:
an unchanged presentation move does not require a cloud/runtime cutover, while
a changed admission, isolation or settlement boundary needs its relevant proof.

### 058.0 — Scope and preserve the baseline

- Map the touched path: current owner, callers, transport/storage dependency,
  destination, preserved behavior and deletion condition. Put the concise map
  in the PR description; do not create another documentation system.
- Check relevant durability/workflow fixes on other branches before selecting
  the extraction baseline. Preserve admission/retry and partial-history rules.
- Reuse existing focused tests and capture one reproducible Web demo path.
- Propose the exact first PR files before editing production code.

### 058.1 — Extract one existing pure read-model capability

Recommended first PR: move `buildDiffContentFromTurnDiff` and its existing tests
from Web's `services/lifecycle/TurnDiffPatchParser` to the existing SDK platform
area, using canonical SDK/protocol types rather than Web API imports.

Update all current callers: WorkflowTimeline, useCompletedTurnReview,
chat-interface/changedFiles and useChangedFilesController. Export the same
function through the existing SDK surface. Delete the old implementation;
do not retain a pass-through compatibility file.

Acceptance: current completed-turn review and inline workflow diff render the
same canonical saved patch. No backend, admission, provider, storage or Desktop
behavior changes. Do not rewrite the parser in the extraction commit.

Continue with other genuinely reusable read models one capability at a time.
Reuse existing SDK workflow/sidebar projections rather than duplicating them.
UI labels and visual selection preferences stay in UI, not automatically SDK.

### 058.2 — Extract conversation presentation, without local runtime work

- Move existing message/transcript presentation, then composer, workflow and
  approval/input/review controls into `client-ui` in dependency-sized PRs.
- Web imports and renders the extracted implementation in each PR. No copied
  component tree or second chat UI. Preserve styles, assets, keyboard handling,
  image inputs, edit/retry behavior and accessible interactions.
- Existing Web orchestration supplies current data/actions initially. A small
  typed props boundary is allowed; no new global store or controller framework.
- Reuse compatible Desktop presentation where already possible. Do not build
  local admission/provider/tool execution to manufacture a second consumer.

Proposed change to 057's two-consumer requirement: an immediately wired Web
consumer is sufficient during this stage. Desktop compilation must remain
healthy, but unimplemented local actions must not be advertised as working.
This relaxation requires adoption of the execution-order change in section 1.

Checkpoint: Web uses the shared conversation UI; it has not yet been declared
a fully thin client, and Desktop is not declared feature-complete.

### 058.3 — Remove transport and product authority from Web, per capability

Take one operation group through SDK, hosted server, Web callers and deletion
before starting the next: thread/history; workspace/provider settings;
Turn admission/retry/revision; replay/follow/interrupt/approval/input; artifacts.

- Extend the existing SDK and App Server with the smallest missing operation.
  Reuse existing canonical contracts and service implementations.
- Keep hosted auth and tenant scoping in Brain composition. Local SQLite,
  Electron credentials and cloud-specific resources do not enter browser SDK
  exports or the shared server's runtime-neutral entry points.
- Existing SDK transports can continue using working hosted endpoints while
  their operation group is migrated. Record any retained path's owner and
  deletion trigger; do not create a second SDK or an unbounded compatibility
  facade. One active authority and subscription path per capability.
- Simplify React hooks to lifecycle binding, presentation and SDK commands.
  Move reusable client retry/acknowledgement mechanics to SDK; keep durable
  admission and terminal settlement in server/runtime owners.
- Do not move `SessionStateService` intact. Separate UI selection/preferences
  from server-backed session operations. Delete local/server reconciliation
  only after the server-backed path covers its valuable behavior.
- Determine whether browser-only records exist before removing durable keys.
  Never erase the only copy of a user's chat. Any import/recovery requirement
  needs an explicit scoped decision before that storage cutover can finish.

Per-group acceptance: the existing real Web action succeeds, reload reconstructs
its canonical state, previous callers are migrated, and the competing Web owner
is removed. Wrapping fetch alone is not completion.

### 058.4 — Thin-Web proof and Desktop resumption decision

- Demonstrate the real hosted path: open saved thread, submit, stream, inspect
  workflow, approve/decline where applicable, stop, review saved output and reload.
- Preserve explicit retry after uncertain delivery, partial assistant output,
  pagination, historical threads without fabricated runtime IDs, image/history
  restoration, and isolation when switching threads or receiving late events.
- Inventory remaining product fetches, storage keys and lifecycle decisions.
  Web-only auth/media-upload/browser integrations may remain with named scope;
  business commands and canonical history/state belong behind SDK/server.
- Confirm `client-ui` has no imports from `apps/web`; SDK has no React/browser
  storage or server-execution dependency leaking into browser bundles.
- Decide readiness to resume 057.6C using shared UI and existing SDK/server
  boundaries. Portability does not prove local execution, offline behavior or
  sandbox security. The original 057 golden-loop acceptance still applies.

## 6. Rules that keep this smaller than the current train

1. No parallel Desktop runtime implementation in these extraction PRs.
2. Isolate mechanical moves from behavior/authority changes in separate commits;
   use separate PRs if either change cannot be reviewed independently.
3. Commit coherent working checkpoints. Use persistent worktrees when explicitly
   authorized, never `/tmp` for a long-lived implementation checkout.
4. Prefer two to five coherent commits per PR. File count is a warning, not an
   artificial limit; isolate mechanical import churn and explain it.
5. Move existing tests with code. Add only proof for a changed risky boundary;
   no tests of trivial forwarding, static markup, types or framework behavior.
6. Run focused checks before full workspace checks. Preflight browser/native
   dependencies. Required CI/review and final gates remain mandatory; reuse
   valid evidence for an unchanged revision rather than rerunning everything
   after every edit.
7. No new package identities, schema duplicates, test frameworks, future-only
   extension hooks, disabled production features or placeholder directories.
8. Fix in-path correctness/security blockers; record unrelated failures instead
   of turning extraction into repository-wide cleanup. A material scope change
   requires revisiting this plan before implementation expands.
9. Update the existing capability ownership ledger when actual ownership changes,
   preserving other agents' edits. A proposed destination is not completed wiring.

### 6.1 Mandatory extraction and simplicity rules

1. **Extract first; do not invent.** Reuse the existing implementation, canonical
   types and active packages. Default changes are relocation, imports, exports
   and the minimum wiring required to keep real consumers working. Do not turn
   extraction into a redesign, new architecture, framework, generic controller,
   abstraction layer, replacement state machine or speculative feature.
2. **Preserve behavior and current edge cases.** A move is not permission to
   change admission, retry, history, permissions, provider policy or settlement.
   If existing code cannot cross the boundary unchanged, identify the precise
   dependency/problem before proposing the smallest adjustment. Do not hide a
   behavior change in a mechanical move.
3. **Research before implementation changes.** Before changing an algorithm,
   control flow, ownership or implementation approach rather than extracting
   it, inspect the relevant actual source in both official Codex and OpenCode
   repositories. Use current source or a clearly identified pinned revision,
   not memory, naming similarities or an earlier research summary. Record the
   source file links/revisions, observed pattern, local problem and smallest
   applicable change in the PR description before implementing that change.
   This requirement is for proposed implementation changes, not every import
   edit or file move. If either repository has no relevant analogue, state that
   explicitly; do not fabricate a precedent. Research does not authorize a
   larger scope, blind copying or a rewrite. Material expansion needs agreement.
4. **KISS — Keep It Simple, Stupid.** Prefer short, literal functions, explicit
   inputs/outputs and one obvious path. Add no machinery merely to look scalable
   or to imitate an upstream repository's package count.
5. **DRY, SOLID and SRP are simplification checks.** Reuse one implementation;
   give each module one clear responsibility; keep dependencies narrow and
   aligned with existing boundaries. These principles do not require a class,
   interface, factory or registry for every function. If direct code is clearer
   and safe, use it.
6. **Delete bad implementations in the touched path.** Remove replaced owners,
   duplicate logic, dead code, obsolete wrappers and unnecessary fallback paths
   once their working replacement is wired. Do not move known bad ownership
   wholesale into a package. Explain the defect, replacement and preserved
   behavior. Keep cleanup scoped; do not delete unrelated work or healthy
   safeguards to reduce line counts. Behavioral fixes follow rule 3.
7. **Delete unnecessary tests, not useful protection.** Remove or consolidate
   tests of trivial forwarding, static markup, framework behavior, duplicate
   assertions with no distinct risk, and tests solely for removed implementations
   when their valuable behavior is covered on the replacement path. Identify
   the removed test and why it is redundant/obsolete in the PR description.
   Preserve high-signal security, data-loss, admission/idempotency, replay,
   settlement and real regression coverage. Never delete a failing/flaky test
   just to make checks green or remove an expectation for an unfixed defect.
8. **Reject complexity at review.** Every new helper, type, dependency and test
   must serve the current extracted capability. Delete needless additions
   before merge. The result must be easier to follow, not merely spread across
   more folders. No production changes are authorized by these planning rules.
9. **Stay on the extraction path; no unnecessary work.** Move the selected
   existing code into its designated folder, update imports/exports and real
   callers, remove the replaced copy, and verify the affected path. Then finish
   that slice. Do not spend time on unrelated research, repeated architecture
   debates, renaming, formatting churn, documentation systems, speculative
   abstractions, new test infrastructure or unrelated cleanup. Mechanical
   extraction requires no upstream research; rule 3 applies only when a real
   implementation change is necessary. Reuse valid verification evidence;
   retain required review/CI and checks affected by the change. Fix only blockers
   to the slice's working path; record unrelated issues and continue. If the
   destination or necessary behavior change is unclear, ask a focused question
   rather than inventing a new structure or silently broadening the task.

## 7. Completion means

Web boots the hosted client, binds browser concerns, and renders shared product
UI driven by SDK operations and canonical server state. No competing browser
authority remains for the scoped thread/workspace/provider/Turn/review journey.
Existing behavior and security boundaries are preserved, replaced code is
deleted, and the real hosted journey passes on the reviewed merged revision.

It does not mean every file left `apps/web`, every client is implemented, Plan
056's responsive matrix passed, or Plan 057's local golden loop passed.

When approved, revise 056/057 sequencing explicitly. For now this document is a
proposal only; no implementation train or existing agent was changed.
