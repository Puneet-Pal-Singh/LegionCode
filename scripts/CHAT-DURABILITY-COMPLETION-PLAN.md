# Chat durability remediation plan

2026-10-04 plan; completed 2026-10-05. **Implementation completed and locally
validated, with GPT-6.1 Sol high source acceptance.** This replaced
the reopened completion sequence with a bounded plan for the three fresh review
findings. Previous validation evidence remains preserved; passing old tests is
not acceptance of these newly identified cases.

Implementation worktree branch: `codex/fix-chat-durability-recovery`, base `8ddaee7d`,
synchronized with main at `f5b61f88` in reviewed merge `506e1242`.
Luna-6 high implements; GPT-6.1 Sol high plans and independently reviews each
slice and final wiring. The coordinator owns preservation and final gates.
Execute sequentially; advance only after the slice's focused proof and review.

2026-10-05 execution clarification: keep the implementation small. Reuse the
existing owners and regression fixtures; add no framework or redundant test
files. Validation uses the smallest tests that prove the actual failure paths,
source review for their wiring, and one final affected-suite/type/browser/golden
pass after source settles. The scenario lists below describe invariants rather
than requiring a separate test or gate for every permutation. Concrete in-path
fixes may proceed from a verified ownership trace without creating another
characterization suite.

## Scope and ownership decisions

| Finding | Chosen correction | Owner after correction |
| --- | --- | --- |
| P1: SDK catches a failed request and resolves append | Capture a per-submission transport outcome, then reconcile with exact-turn canonical evidence | Narrow Web SDK adapter for delivery; PostgreSQL admission and canonical lifecycle for acceptance/execution |
| P1: saved idle/default-title chat never loads history | Mount one session conversation surface and read history before selecting setup or transcript | Existing session-scoped SDK history/hydration owner; setup is a UI choice from a completed read |
| P2: unidentified old reply is labeled as the current turn | Remove list-scanning identity assignment; SDK assistant frames remain transport-only | Canonical transcript and lifecycle projections for identity, phase, items, and output |

No server `hasTranscript` flag, new history endpoint, persistence schema change,
or second history loader is planned. Presentation title, cached status, active
run, and transport message count cannot establish whether saved history exists.
Unknown legacy metadata remains unknown.

The two history/rendering changes share one dependency: verified session
history must survive transport-instance resets. Establish that owner before
rewiring App's setup decision. Update the capability ledger alongside the
actual ownership changes. Do not expand into unrelated cleanup.

## 1. Preserve and characterize the failures

Owner: coordinator and Luna; Sol reviews the failing cases.

- Preserve current source plus the amended plan/report in a new private
  snapshot. Retain the earlier accepted archive and all output evidence.
- Add focused regressions that fail on the current implementation. Use the
  installed `@ai-sdk/react@1.1.0` for transport tests; stub HTTP/lifecycle/provider
  boundaries as needed, but do not replace SDK append with a rejected mock.
- Reproduce cold-cache saved history with default title/idle status through the
  actual App route, and unidentified historical replies through the real
  history-to-presentation path.

Gate: each finding has a failing regression exercising its actual consumer;
failure is the missing behavior, rather than fixture setup or unavailable
credentials. No application or database changes before the behavior is captured.

## 2. Make SDK delivery outcomes explicit

Owner: Luna; Sol reviews before proceeding.

Files: `apps/web/src/hooks/useChatCore.ts`, a focused helper under `hooks/chat/`,
`Workspace.tsx`/tests, existing initial-prompt queue/claim owner, and a proposed
`hooks/useChatCore-transport.test.tsx` integration regression.

- One per-submission record captures token, original session/run, client message
  ID, exact request scope, observed response/error, and user Stop intent.
  Prevent concurrent submissions from sharing one outcome record. Bind late
  callbacks to their original request; switching chats cannot settle another
  queue, input, or revision.
- Capture SDK callback failures synchronously and inspect the record after SDK
  append settles. Neither the resolved return value nor React error state is
  sufficient evidence of successful delivery. Positive acceptance requires a
  successful completion/acknowledgement bound to the exact original request
  tuple, or exact-turn canonical evidence. Absence of a callback error is not
  itself acceptance. An inactive-scope early return cannot consume a queue as
  though dispatch or acceptance occurred.
- On HTTP/network/stream failure, use exact-turn canonical evidence. Evidence
  means accepted work continues through replay without reexecution. Missing or
  unavailable evidence means unconfirmed delivery: retain the original intent
  and client ID, expose an error, and permit explicit retry only.
- Freeze the semantic request snapshot for same-ID retries: exact submitted
  message JSON/content/attachments, revision target, identity, mode, provider,
  model, and branch. Preserve SDK-added fingerprint material rather than
  regenerating it on retry. Reuse this snapshot and its original client ID for
  unchanged setup/composer/revision intents. Changing any fingerprinted field
  creates a new intent/ID; do not regenerate a different same-ID request from
  current UI configuration. Clear stale error state per request.
- Consume the setup queue only after acceptance. Preserve the queue and retry
  alert on rejection/unconfirmed delivery. Ordinary submit returns false and
  restores input; rejected revision retains its original displayed branch.
- Characterize an unconfirmed setup prompt in chat A, then Start in chat B
  and switch back to A. Upgrade the existing App initial-prompt owner to
  session-keyed pending intents so A remains reachable; callbacks compare both
  session and submission ID before retiring an intent. Keep the existing
  submission-claim owner and history loader; do not introduce another queue.
- Stop before `/chat` dispatch is definitely unadmitted cancelled intent;
  `/turn/start` reservation alone is not prompt admission. After dispatch but
  before acknowledgement/first lifecycle evidence, acceptance is uncertain:
  reconcile and, if necessary, interrupt the exact turn, without labelling it
  definitely unadmitted or automatically resending. Once admission is known,
  Stop follows canonical interruption/terminal replay. Cancellation never
  masquerades as successful delivery or ordinary transport failure.

Gate: actual installed-SDK tests cover HTTP 503, network rejection, broken body
stream, transport loss after canonical acceptance, Stop before dispatch,
Stop after dispatch before first evidence, Stop after confirmed admission,
immutable same-ID retry (including mode/provider/model/branch/message JSON),
changed intent, callback churn, remount, and switching
sessions while a response is pending, including Start in B while A is
unconfirmed and returning to A. Unaccepted sends retain intent; accepted
sends start no duplicate execution; rejected edits hide no historical branch.

## 3. Make verified history the product message source

Owner: Luna; Sol reviews before proceeding.

Files: `useChat.ts`, `useChatCore.ts`, `useChatHydration.ts`,
`hooks/chat/activeTurnMessageIdentity.ts`, the current
`useChatCore-message-identity.test.ts`, a proposed integrated history/presentation
regression, `components/chat/messageMetadata.ts`, `chat-interface/chatEntries.ts`, and
cache/artifact consumers only where their wiring must change.

- Keep the verified transcript cache in the existing session-scoped chat
  composition, separate from SDK transport messages. Existing hydration owns
  snapshots, paging, partial/error status, cancellation, and refresh.
- Remove `attachActiveTurnIdentity` and its full-list scanning call. Do not
  replace them with scope, position, text, or phase guessing.
- Product messages are verified transcript plus explicitly submitted pending
  user input. Live assistant/workflow output comes from canonical lifecycle
  projection; SDK assistant frames are delivery frames and do not independently
  render or enter the durable-history cache.
- Reconcile the pending user by stable client ID when its committed row arrives.
  Canonical history supplies item/phase/turn metadata; preserve unresolved
  historical rows and their text. Update cache/artifact consumers to follow the
  same source rather than recreating transport ownership.
- A changed or cleared active run may reset the SDK instance, but must not clear
  verified history. Refresh/reconcile hydration on the appropriate instance or
  terminal changes without gating reads on runtime scope.

Gate: an unidentified old reply stays unidentified and visible while a later
turn starts, fails without output, completes, or reloads. Equal text in distinct
commentary/final items stays distinct. Live and hydrated final output appear
once. Null-run changes, terminal clearing, switching, and SDK instance resets
preserve the selected session's transcript without leaking another session.

## 4. Choose setup only after session history is known

Owner: Luna; Sol reviews before proceeding.

Files: `App.tsx`, a proposed thin
`components/layout/SessionConversationSurface.tsx`, `Workspace.tsx`, the
exported `useChat` result type, setup wiring, and browser history fixtures.

- App mounts the surface for every selected authenticated session, keyed by
  session ID. It hosts the single existing chat/hydration composition and passes
  that typed result/actions to Workspace. Remove Workspace's own hook invocation.
- A known unsaved draft keeps setup/save-retry behavior; history and admission
  stay blocked until its save succeeds. A queued Start intent must remain
  available to the surface and preserve the existing save-readiness guard.
- For a saved selection, initiate history loading regardless of title, cached
  status, provider readiness, active run, or scope availability. A full,
  successful empty read with no queued/accepted work may show AgentSetup.
- Loading, failed, partial, cancelled, or stale reads never establish emptiness.
  Show the existing loading/transcript/recovery state, retaining verified rows
  when available. Do not offer setup as a substitute for a history error.
- Retain queued/accepted submission state while refreshing an initially empty
  watermark. Clearing a handled queue must not briefly restore setup. Run
  changes stay inside the session boundary and cannot remount history ownership.

Gate: cold-cache saved `New Task`/empty-title + idle chats load their messages;
null-run and scope-404 chats do likewise with zero execution/admission POSTs.
A genuinely empty saved session and a new unsaved draft still support setup.
Save failure/retry, an initially empty snapshot during Start, provider absence,
slow/failed/partial reads, chat switching, refresh, and terminal run clearing
choose the correct surface. Exactly one history loader owns each selected
session; stale responses cannot replace the newly selected session.

## 5. Clarify the supported recovery operation

Owner: Luna; Sol reviews the runbook change.

Update `apps/brain/scripts/CHAT-HISTORY-RECOVERY.md` to explicitly require an
isolated restored target with exclusive writes throughout inventory, freshness
checking, apply, repeat apply, and verification. No app/admin/second recovery
writer may mutate it during this operation. Keep backups and manifests private.

Do not claim online/shared recovery safety. The existing freshness check precedes
per-session transactions and is not a concurrent-writer isolation mechanism.
Online recovery would require a separately designed enforcement/locking change.
No recovery apply, metadata repair, worker migration, or source-DB writes are
part of this remediation execution.

Gate: runbook and verification report state the same operational prerequisite;
previous clone-only preservation proof remains accurately scoped.

## 6. Validate the complete consumer path and review the final source

Owner: coordinator; final independent review by Sol.

- Run focused regressions after each slice. Review the actual producers,
  consumers, removed competing owners, and installed SDK behavior; mocked
  component promises alone cannot satisfy acceptance.
- After source stops changing, run full Web tests with bounded workers and its
  typecheck. Run controlled browser tests sequentially after unit/type work;
  preserve the existing 600-message/scope-404 and lifecycle/golden coverage.
  Add browser failure/retry coverage through the actual App and SDK request.
- Run the exact golden gate against final source. Ensure the previous test
  server released its port before starting another browser gate; do not relax
  assertion/timeouts or reuse an unknown server to force a pass.
- Reuse unchanged Brain/Persistence/SDK/Protocol/PostgreSQL/recovery/writer proof.
  Rerun affected packages and real PostgreSQL cases if implementation crosses
  their contracts. Never label earlier runs as fresh runs of changed source.
- Update the existing verification report/ownership ledger with actual results,
  outstanding skips, and source fingerprints. Save a new verifiable private
  source archive and gate logs, preserving all earlier evidence.

Commands after implementation (new test paths are proposed, not yet present):

```sh
corepack pnpm --filter @legioncode/web exec vitest run --maxWorkers=4 --minWorkers=1
corepack pnpm --filter @legioncode/web check-types
corepack pnpm --filter @legioncode/web exec playwright test chat-history-recovery.spec.ts runtime-lifecycle-golden.spec.ts --workers=1
corepack pnpm gate:golden-repo-to-pr
git diff --check
```

Final gate: all three current regressions are fixed and pass through real
consumer wiring; no unresolved in-scope P1/P2, no new execution from history
reads, no invented identities, and no lost/unconfirmed prompt treated as
accepted. Sol's final review and the source archive must agree with the tested
checkout. Failure returns to its owning slice before completion is reported.

## Preserved baseline and completion boundary

Earlier package suites: Brain 826, Persistence 210, Web 721, SDK 110, Protocol
75. PostgreSQL 8, recovery 9, actual writers/launchers 15, controlled browsers
2 and golden gates passed. Archived source/evidence hashes matched at fresh
review; only plan/report documentation changed afterward. These are preserved
baseline results and do not cover the new regressions.

The original inspected database retained 306 sessions, 850 messages, 1,077 parts,
and 8,909 lifecycle events. Source/clone content fingerprints matched; recovery
was applied twice only to a restored clone. No source-database apply or deployment
occurred. Private evidence remains in sibling recovery-records/safety directories.

Implementation completion requires the six remediation gates above. Authenticated
production-browser checks, actual worker/provider migration, and remote artifact/
bucket verification remain explicit release gates. The user has authorized implementation, periodic commits, PR publication,
and final PR review. Each reviewed slice is committed before the next slice.
No merge or deployment is included.

## Completed execution

All six remediation steps are complete. Actual SDK/App/identity regressions
were preserved in `2e6ea5ed`; reviewed delivery fixes are in `88dda1d6`; combined
verified transcript, session surface, queue retention, scoped Stop settlement
and recovery writer documentation are in `16f87c2f`. The completion slice reused
existing fixtures and removed obsolete identity/visibility helpers.

Final Web source passed 741 tests, type checking, scoped lint, two saved-history
browser cases and the exact golden command. The authenticated real-product
route remained explicitly skipped without storage state. Sol accepted final
source ownership and wiring. Original database fingerprints still match.
See the verification report for retained package results and baseline engine
failures. PR publication/final published-diff review follow; merge, deployment,
and production recovery remain outside this execution.
