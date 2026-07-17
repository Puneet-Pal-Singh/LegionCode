# 2026-07-03 Architecture Red Flag Tracker

## 2026-07-17 cloud-stability release update

This release branch records the implementation evidence for the cloud-stability
incidents. The target-cloud product proof remains required before any incident
is marked closed.

- **INC-013 — FIXED_PENDING_PROOF**: terminal assistant projection now accepts
  model text only from explicit typed `final` transcript parts. Deterministic
  runtime text requires a tagged runtime-final contract. Existing focused
  completion tests pass; real greeting/read replay proof remains required.
- **INC-008 — FIXED_PENDING_PROOF**: lifecycle protocol and projection now have
  a durable typed `awaiting_approval` status with legal enter/leave transitions.
  Runtime approval continues through the persisted approval store and typed
  lifecycle decision path. Real edit approval/resume proof remains required.
- **INC-009 — FIXED_PENDING_PROOF**: turn bootstrap is idempotent for the
  server-owned `(threadId, turnId, runAttemptId)` tuple and execution rejects
  mismatched identities before mutation. Focused bootstrap/lifecycle tests pass.
- **INC-001 — QUARANTINED**: the Cloudflare Agents Durable Object route is no
  longer deployed or exported; the canonical RunEngine Durable Object owns the
  live stream. The old class is retired by the v6 migration. No cross-owner
  stream object is passed on the active route.
- **INC-002 — FIXED_PENDING_PROOF**: production and local Secure API container
  capacity are explicitly `max_instances: 2`; Brain admission is capped at the
  same value and `gate:cloudflare-capacity` verifies the contract.
- **INC-003 — FIXED_PENDING_PROOF**: Web Git probing/bootstrap is gated on the
  canonical run scope and readiness state. Target-cloud proof remains required.
- **INC-004 — FIXED_PENDING_PROOF**: terminal 204 artifact misses are treated
  as terminal no-artifact results and excluded from further hydration retries.
- **INC-010 — FIXED_PENDING_PROOF**: Brain polling and the Secure API
  `/api/v1/logs` polling route were removed; canonical runtime events own live
  continuation. Secure session absence remains an explicit lease outcome.
- **INC-011 — FIXED_PENDING_PROOF**: Secure API log messages and sandbox log
  entries pass through the redaction boundary; focused sanitizer and adapter
  tests pass. No credential-bearing cloud validation has been claimed.
- **INC-012 — FIXED_PENDING_PROOF**: revoked-auth recovery now has an explicit
  `/auth/github/reauthorize` OAuth action, which reuses the control-plane
  callback and never places tokens in browser URLs or logs.
- **INC-014 — FIXED_PENDING_PROOF**: Brain local startup now validates the
  ignored Wrangler config's Durable Object bindings and migrations against the
  checked-in canonical config before building or launching Wrangler. A tracked,
  secret-free template carries the canonical v6 deletion migration, and drift
  fails with one fixed remediation message. Focused local-config tests (5/5),
  Brain typecheck, standalone launcher shell validation, and formatting checks
  pass; real local OAuth startup proof remains required.

## 2026-07-17 post-PR-406 recovery evidence

PR #406 was merged to `dev`, but the following failures were reproduced on
`dev` after the merge. These are product-path failures, not test-only gaps:

- A plain `Hi` rendered `The run completed without a model-written final
  response.` because provider text was translated as non-final visible text
  and the finalizer correctly refused to guess. The repair must promote only
  the terminal provider response to an explicit typed `final` part.
- The Web surface showed no safe lifecycle state while a request was running.
  The repair keeps the server-owned turn projection attached and renders only
  `Starting`, `Working`, `Waiting for approval`, `Completed`, or `Failed`.
- `hey say ok` surfaced the generic `RunEngine DO execution failed` message.
  The repair carries canonical runtime failure codes through tool settlement so
  the user sees an actionable runtime/sandbox/workspace failure rather than a
  provider setup diagnosis.
- Secure API evidence showed `workspaceScope: Required`, a
  `DataCloneError: Could not serialize object of type DurableObject` from
  `CloudflareSandboxExecutionAdapter.destroySandbox`, HTTP 500 on terminal
  session deletion, and sandbox readiness failures reporting the container port
  was not found or readiness was aborted.

Status: **IN_REPAIR** in the follow-up repair PR from latest `origin/dev`.
The implementation proof covers typed finalization, canonical thread/turn/
run-attempt/workspace/root scope, direct Sandbox lifecycle destruction, terminal release, and
the image/readiness port contract. Authenticated target-dev acceptance proof
for greeting/read, Working state, scope logs, no DataCloneError, successful
DELETE, and canonical failure presentation remains required before closing
these red flags.

### Required release proof

Run the authenticated target-dev product gate for greeting/read, edit approval,
reload/follow-up, concurrent isolated chats, terminal lease release, and
credential-safe logs. Do not change the statuses above to `CLOSED` until that
gate produces sanitized evidence for each flow.
