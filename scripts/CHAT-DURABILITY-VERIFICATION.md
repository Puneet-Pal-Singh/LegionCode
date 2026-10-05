# Chat durability verification

2026-10-05. Implementation branch: `codex/fix-chat-durability-recovery`.
GPT-6 Luna high implements; GPT-6.1 Sol high directs and independently reviews.
Implementation and final local validation are complete; Sol accepted the final
source wiring. PR publication and published-diff review follow. Production
rollout remains separate from implementation acceptance.

## Cause and data preservation

The inspected PostgreSQL database retained 306 sessions, 850 messages, 1,077
message parts, and 8,909 lifecycle events, with no orphaned transcript rows.
Logs showed 69 scope reads returning 404 while session listing succeeded.
Of 74 non-archived chats with messages, 71 lacked current runtime scope while
retaining 242 messages.

History incorrectly depended on ephemeral execution scope. Renaming the Brain
worker also separated local runtime namespaces while PostgreSQL remained shared.
Web omitted saved chats with null active runs and used cached title/status to
choose setup before reading history. Together these made surviving saved chats
inaccessible. The inspected evidence does not establish autonomous chat deletion.
Secure API cleanup concerns execution leases; the screenshot's file reads
succeeded. This conclusion applies to the inspected data, not every production
chat.

The final read-only source check matches all four original count/content
fingerprints. No recovery apply or failure injection targeted the source database.
Earlier source archives and evidence remain preserved privately outside Git.

## Final implementation

- Owned history uses a stable conversation binding and pinned snapshot pages;
  null runs and missing runtime scope do not bootstrap execution.
- PostgreSQL atomically admits prompt/run/turn identity. Only the pending owned
  tuple may claim execution. Canonical lifecycle append persists assistant
  phase/item and terminal projections atomically.
- The Web SDK adapter observes the exact request acknowledgement or exact durable
  lifecycle evidence. Caught SDK errors without a bound acknowledgement or exact
  canonical admission evidence remain unconfirmed. Unchanged explicit retries
  retain client identity and
  request bytes; cancellation and delayed callbacks stay invocation-scoped.
- One session-keyed surface owns verified history across run changes. Full reads
  replace it; partial reads retain prior verified rows. Only a pending user is
  optimistic. Cache/artifacts consume verified rows, and SDK assistant frames
  remain transport-only.
- Saved chats load before choosing setup, including default-title idle chats.
  Setup requires a complete empty read with no queued or pending work. App keeps
  queued setup intents per session and clears only the exact submission.
- Historical identity remains unknown unless proven. Multiple assistant phases
  remain visible; duplicate suppression requires exact turn/item/phase evidence.
  Accepted edits refetch canonical history instead of filtering it locally.
- Recovery imports verified tuples and unambiguous links only. Both local
  launchers serialize writer ownership and refuse unsafe orphan state.

The fresh review's three defects—false SDK delivery success, default-title
history routing, and historical identity guessing—have been implemented and
reviewed. Focused installed-SDK and actual product-path regressions cover them.
The earlier identity-guessing and obsolete visibility helpers were removed.
No new framework or redundant test suite was added in the completion slice.

## Recovery evidence and prerequisite

Recovery was applied twice only to a disposable restored database, with identical
reports: 306 checkpoints, 147 imported admissions, 216 stable legacy thread
bindings, 74 unambiguous transcript/event links, 76 verified current-turn bindings,
and 230 current turns left unset. Invalid current bindings and unbound recovered
threads were both zero. All 25 copied local artifacts matched bytes, length, and
digest. Ownership drift was rejected before writes.

Unknown groups and 56 legacy status divergences remain unresolved; the importer
does not manufacture replies or terminal status. Recovery requires an isolated
restored target with one writer throughout inventory, freshness checking, apply,
repeat apply, and verification. Stop application, admin, and second recovery
writers. Freshness is checked before per-session transactions, so online
concurrent recovery safety is not established.

## Validation

| Gate | Result |
| --- | --- |
| Brain full suite | 849 passed |
| Persistence full suite | 210 passed; eight opt-in PostgreSQL cases run separately |
| Final Web full suite | 741 passed across 122 files |
| Platform client SDK / protocol suites | 110 / 75 passed |
| Runtime kernel / native context suites | 58 / 6 passed |
| Real PostgreSQL durability suite | Eight passed on disposable restore |
| Recovery selector / actual local writer-launcher checks | Nine / 15 passed |
| Completion focused cases | 58 passed; 38 affected cases and eight hydration cases rechecked after lint cleanup |
| Affected package typechecks | Passed; Web rerun after final source changes |
| Scoped Web, Brain, SDK and protocol lint | Exit zero; Brain configuration intentionally ignores runtime/test paths |
| Cold-cache saved history browser cases | Two passed; includes 600-message pagination, null run, scope loss, switches and reload |
| Exact golden repo-to-PR command | Exit zero; conformance types/unit and lifecycle browser passed |
| Authenticated real-product route | Skipped: authenticated storage state unavailable |
| Source database fingerprints / diff check | All four original fingerprints unchanged / passed |

The five primary package suites passed 1,985 tests. The eight PostgreSQL cases
skipped by the default command all passed in the opt-in real database run.
Final Web, history browser, golden, types, lint and focused outputs are preserved
with the private final source evidence. Brain/Persistence/SDK/protocol source was
unchanged after its recorded passing checks; the runbook edit is documentation.
Sol reviewed the actual installed SDK semantics, active producers/consumers,
history owner, session route, exact identity matching and late-callback fencing.
Reviewed production slices are committed as `88dda1d6` and `16f87c2f`, following
the preserved foundation and main synchronization commits.

The broader execution-engine command recorded 1,074 passing tests, six failed
tests, one skipped test, and one suite-load failure. The identical seven failure
names were reproduced on pristine main: four RunEngine assertions, two missing
ExecutionLogger constructor cases, and a removed observability module import.
These are unrelated baseline failures; no execution-engine change is included.

Private gate logs, source archives, per-file digests, and read-only database
fingerprints are retained outside Git. Earlier accepted archives remain intact.
Generated browser outputs and database contents are excluded from this PR.

## Release boundary

No deployment, source-database recovery apply, or actual worker namespace
migration was performed. Controlled browser fixtures and local artifact copies
do not establish production recovery. Authenticated production-browser recovery,
real worker/provider migration, and remote artifact/bucket verification remain
release checks. Implementation acceptance does not authorize those actions.
