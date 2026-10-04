# Chat durability verification

2026-10-04. Implementation is in the `codex/fix-chat-durability-recovery`
worktree, based on `8ddaee7d`. **Completion reopened after fresh source review.**
The recorded test gates passed, but three consumer defects remain. Implementation
is not fully complete; those defects are separate from the production release
limits recorded below.

## Fresh review: outstanding implementation findings

This read-only review checked the actual installed SDK, application consumers,
original D1–D10 plan, and archived evidence. Before these status-document edits,
all 2,108 source files and all archived evidence hashes matched the previously
validated checkout. Test totals and recorded database preservation proof are
accurate; they do not cover the defects below. No new tests, implementation
changes, or database writes were performed during this review.

1. **P1: SDK transport errors resolve as successful submission.**
   `apps/web/src/hooks/useChatCore.ts:656` awaits the installed SDK's append;
   `:805` expects HTTP/network/stream failure to reject. Installed
   `@ai-sdk/react@1.1.0` catches that failure, calls `onError`, and resolves.
   Our `onError` at `:396` only logs and does not capture/propagate that outcome.
   If turn bootstrap succeeds but the chat request fails before admission,
   canonical acceptance checking never runs. Workspace clears the queued prompt
   as handled at `Workspace.tsx:377`, ordinary submission reports success, and
   a rejected revision can remove its old branch from the local display.
   The retry regression mocks an append rejection, which does not represent
   the real SDK behavior. Required proof: actual hook + installed SDK with a
   failed HTTP/network request before admission, followed by explicit retry
   with stable identity; also distinguish transport loss after acceptance.

2. **P1: saved nonempty chats can still render setup without loading history.**
   `apps/web/src/App.tsx:656` decides whether to mount Workspace from title and
   status. A saved chat titled `New Task` (or empty) with `idle` status renders
   AgentSetup even if durable messages exist. After clearing browser caches,
   session history never loads because Workspace/hydration never mounts.
   `SessionStateService` supplies saved status, but the route does not use a
   durable transcript-presence result. Required proof: cold-cache selection of
   this saved legacy shape loads its messages without admission/execution;
   genuine empty new-session setup still works.

3. **P2: unresolved historical assistant identity is invented in Web.**
   `apps/web/src/hooks/useChatCore.ts:482` applies
   `hooks/chat/activeTurnMessageIdentity.ts:15` to the full hydrated list. It
   labels the last assistant lacking turn metadata with the active turn and
   `final_answer`, without proving the reply came from the current request.
   An old unidentified reply can therefore be associated with a later turn
   that produced no assistant output; conversation grouping can also overwrite
   the older prompt's displayed turn identity. Required proof: an unidentified
   historical reply stays unidentified and visible when a later turn starts,
   fails, or reloads; only proven new live output may receive its request scope.

The six-step final source acceptance is withdrawn pending these fixes and
consumer regressions. A bounded remediation plan is now prepared in
`scripts/CHAT-DURABILITY-COMPLETION-PLAN.md`; implementation and new test execution
have not started. The existing recorded passing suites remain historical
acceptance evidence, rather than proof that these newly found cases work.

The recovery CLI's freshness proof assumes the plan's exclusive-writer isolated
restore. Its runbook should explicitly require no app, admin, or second recovery
writer throughout inventory/apply/verification. Freshness is checked before the
per-session transactions; they do not revalidate every semantic ownership/run
field under locks. Concurrent online recovery is not established by the existing
proof. This does not invalidate the recorded exclusive-writer clone runs.

## Why old chats could not open

The inspected PostgreSQL database still contained 306 sessions, 850 messages,
1,077 message parts, and 8,909 lifecycle events, with no orphaned transcript
rows. The supplied logs showed 69 failed scope reads with HTTP 404 while session
listing succeeded. Of 74 non-archived chats with messages, 71 lacked their
current runtime scope while retaining 242 messages.

History loading incorrectly depended on ephemeral runtime scope. The worker
rename from `shadowbox-brain` to `legioncode-brain` also separated local runtime
state namespaces while PostgreSQL remained shared. The client omitted saved
chats with a null active run and conflated cached run identity with conversation
identity. These conditions made saved chats inaccessible even when their
transcript rows survived.

The inspected logs and database do not establish autonomous chat deletion.
Secure API session cleanup refers to execution leases; the screenshot's file
reads completed successfully. This investigation cannot prove preservation of
every past chat or of an uninspected production database.

## Implemented boundaries

- Owned history reads use the stable conversation binding and fixed snapshot
  pagination. Missing runtime scope or a null active run does not prevent
  history loading or create an execution attempt.
- PostgreSQL atomically admits a user prompt, run, and exact turn/attempt
  identity. Replay reconstructs identity from durable admission, and only the
  pending owned tuple can claim execution. Task/session/run workspace conflicts
  fail before writes.
- Canonical lifecycle append atomically persists transcript and terminal
  projections. Phase/item identity preserves distinct assistant output, exact
  chunk whitespace, and repeated prompt text. History and model context apply
  snapshot-scoped revisions, including imported identities.
- SDK history reads fetch every pinned page and surface incomplete reads. Web
  treats cached history as a cache and waits for successful session saving
  before hydration or prompt admission. Failed queued setup prompts retain the
  same client message ID for explicit retry; failure state survives navigation
  and Workspace remounts in the existing initial-prompt claim owner.
- Recovery imports only verified runtime tuples and unambiguous projection
  links. Whole-session latest-prompt evidence controls current-turn selection;
  unknown or conflicting evidence remains unset. Semantic manifest freshness
  and per-session checkpoints guard application and repeat application.
- Both local launchers serialize writer ownership and record the worker process
  group before starting its writer. Unknown, malformed, foreign, or live orphan
  evidence blocks startup. Reclaim/release requires proof that the group died.
  Canonicalizing the CLI path fixes macOS symlinked entrypoint detection.

## Recovery and preservation evidence

The source database and original runtime roots were preserved. Database writes
and failure injection used disposable PostgreSQL restores. A newly generated v2
manifest was applied twice to the final restore with identical reports:

| Evidence | Result |
| --- | --- |
| Session checkpoints | 306 |
| Exact imported admissions | 147 |
| Legacy sessions assigned stable threads | 216 |
| Unambiguous transcript/event identity links repaired | 74 |
| Verified current-turn bindings | 76 |
| Unprovable current turns left null | 230 |
| Invalid current-turn bindings / unbound recovered threads | 0 / 0 |
| Copied local artifact bytes, length, and digest verified | 25 / 25 |
| Ownership drift before apply | Rejected before any checkpoint or admission writes |

Original session/message/part/lifecycle fingerprints match both the source and
the restored database after recovery and integration tests. They cover original
IDs, text, JSON metadata, ordering, timestamps, archive state, owner, workspace,
task, title, and lifecycle content. Recovery added identity/provenance metadata;
it did not invent or rewrite transcript text.

There are still 56 legacy status divergences without an attributable terminal
event. Ambiguous assistant identity groups and events without valid tuples
remain unresolved. The importer does not manufacture completions, failures,
turns, or replies to hide these gaps.

## Previously executed validation

Luna-6 high executed fixes and GPT-6.1 Sol high reviewed each sequential plan
step and the final consumer wiring. A fresh review subsequently found the
consumer gaps above and withdrew final completion acceptance. Private output logs, manifests, source
snapshots, and database fingerprints are retained in sibling
`chat-durability-recovery-records/` and `chat-durability-safety-2026-10-03/`
directories, outside Git.

| Gate | Final result |
| --- | --- |
| Brain full suite | 826 passed |
| Persistence full suite | 210 passed; 8 opt-in PostgreSQL tests run separately |
| Web full suite | 721 passed |
| Platform client SDK full suite | 110 passed |
| Platform protocol full suite | 75 passed |
| Real PostgreSQL durability suite | 8 passed |
| Recovery selector/checkpoint/freshness tests | 9 passed, zero skips |
| Actual local launchers and writer ownership tests | 15 passed, zero skips |
| Brain/Persistence/Web/SDK/Protocol typechecks | All five passed against final package source |
| Controlled saved-history and lifecycle browser tests | 2 passed against final Web source |
| Golden repo-to-PR gate | Exit 0; conformance types, unit test, and controlled lifecycle browser passed |
| Authenticated real-product browser | Skipped: no authenticated storage state supplied |

The five package suites passed 1,942 tests. The eight opt-in PostgreSQL cases
skipped in the normal Persistence command all passed in the separate real
database run; they are not an outstanding skip. The authenticated browser is
the sole unexecuted browser case.

Final evidence logs include `completion-brain-test-reviewed.log`,
`completion-persistence-test.log`, `completion-web-remount-final.log`,
`completion-web-types-remount-final.log`, `completion-sdk-test.log`,
`completion-protocol-test.log`, `completion-postgres-isolated.log`,
`completion-recovery-selector.log`, `local-writers-step5-reviewed.log`,
`completion-browser-final.log`, and `completion-golden-final-retry.log`.
The first final golden attempt encountered a test-server shutdown port conflict;
rerunning after the port was released passed without source or timeout changes.
Earlier resource-contention failures and superseded runs remain preserved, but
they are not the final-source acceptance evidence. `git diff --check` passed.

The previously accepted source checkout, including new migrations, tests, plan, report,
and ownership ledger, is preserved in `completion-accepted-source.tar.gz` with
per-file and archive SHA-256 hashes in `completion-accepted-source-manifest.json`.
No private database contents or generated browser outputs were added to Git.
The earlier archive remains intact; this review updates the plan and report
status without altering implementation source or rewriting prior evidence.

Real PostgreSQL tests cover 600-message snapshot paging, distinct interleaved
phases, 1,100-delta terminal replay, prompt/projection rollback and retry after
injected post-write failures, older terminal replay after newer same-run
settlement, imported revisions with unchanged stored metadata, competing
revisions on separate connections, and owned-task workspace admission.

The controlled browser fixtures and copied local artifact bytes do not prove
production recovery. Authenticated production-browser recovery, real worker
binding migration, remote artifacts/buckets, and provider migration remain
external release gates. No deployment or source-database recovery apply was
performed.
