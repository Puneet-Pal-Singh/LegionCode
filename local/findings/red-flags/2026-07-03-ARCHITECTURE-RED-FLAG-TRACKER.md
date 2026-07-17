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

### Required release proof

Run the authenticated target-dev product gate for greeting/read, edit approval,
reload/follow-up, concurrent isolated chats, terminal lease release, and
credential-safe logs. Do not change the statuses above to `CLOSED` until that
gate produces sanitized evidence for each flow.
