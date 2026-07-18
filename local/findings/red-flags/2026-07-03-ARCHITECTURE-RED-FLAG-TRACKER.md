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
- **RF-022 — FIXED_PENDING_PROOF**: provider catalog bootstrap is now registry-
  only; remote model discovery is owned by `ProviderCatalogService`, scoped to
  the selected provider, bounded to 5 seconds, and returns typed unavailable
  metadata without inventing models. Static registry defaults preserve normal
  chat resolution, stale cache responses remain usable, and Web bootstrap no
  longer preloads every connected provider. The legacy unpaginated model route
  and duplicate preload/fallback owners are removed; explicit refresh is bounded
  by the same catalog timeout. Focused catalog, controller, provider-store, and
  bootstrap-isolation tests pass; authenticated target-cloud proof remains
  required.

## 2026-07-17 artifact provenance repair

- **ARTIFACT-P0-MESSAGE-OWNERSHIP — FIXED_PENDING_PROOF**: artifact review
  lookup now requires the server-owned `threadId`, `turnId`, `runAttemptId`,
  and `workspaceId` together with `runId` and `assistantMessageId`. The
  Brain review service has no latest-artifact fallback for by-message reads;
  Postgres and memory repositories apply the complete identity predicate; the
  files and diff endpoints require the same identity; and Web rejects any
  response whose assistant-message or turn identity differs from the request.
  Evidence: `EditArtifactReviewService.test.ts`,
  `MemoryArtifactRepository.test.ts`, `edit-artifacts-client.test.ts`, the
  Web `changedFiles` and `ChatInterface` tests, and Brain/Web typechecks pass.
- **ARTIFACT-P0-CAPTURE-OWNERSHIP — FIXED_PENDING_PROOF**: the existing
  capture coordinator remains the sole capture owner and records artifacts
  only from edit-tool mutation metadata with a non-empty changed-file set; it
  does not derive a failed/no-edit artifact from live Git. The coordinator,
  patch metadata, assistant transcript metadata, and persisted artifact row
  now carry the same server-issued identity. Evidence: the existing
  `EditArtifactCaptureService.test.ts` failed/no-edit and baseline gates pass;
  `EditArtifactReviewService.test.ts` verifies saved-patch reads without live
  Git; the R2/object-store round trip preserves that identity; and the
  artifact migration has a unique ordered slot with migration safety coverage.
  Evidence: `EditArtifactObjectStore.test.ts`,
  `PostgresMigrationRunner.test.ts`, `gate:rebuild-governance`,
  `gate:capability-preservation`, and shared-types, persistence, Brain, Web,
  and Secure API typechecks pass.

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

Status: **FIXED_PENDING_TARGET_PROOF** in the follow-up repair PR from latest
`origin/dev`. The implementation proof covers typed finalization, canonical
thread/turn/run-attempt/workspace/root scope, direct Sandbox lifecycle
destruction, terminal release, and the image/readiness port contract.
Authenticated target-dev acceptance proof for greeting/read, Working state,
scope logs, no DataCloneError, successful DELETE, and canonical failure
presentation remains required before closing these red flags.

## 2026-07-18 canonical chat activity and final-settlement proof

- **INC-013 — FIXED_PENDING_TARGET_PROOF**: the runtime now rejects
  `COMPLETED` settlement without an explicit typed model `final`; it never
  manufactures generic successful copy. A local authenticated browser run
  displayed `Starting`, produced the model-written final `OK`, and preserved
  that final after replay.
- **INC-009 — FIXED_PENDING_TARGET_PROOF**: each submitted client message now
  bootstraps one server-owned turn and run-attempt identity. Retrying the same
  client message remains idempotent, while a follow-up message receives a new
  tuple. This removes the static turn tuple that caused second-message
  lifecycle conflicts.
- **RUNTIME-WORKSPACE-IDENTITY — FIXED_PENDING_TARGET_PROOF**: Brain and the
  runtime kernel now derive the same branded workspace id from the external
  workspace identity. Before the repair, the first real tool call failed with
  `Execution workspace scope must match the server-owned run scope`; after the
  repair, a real `package.json` search/read completed and replay preserved the
  typed `Finding` and `Reading` activity.
- **ACTIVITY-PRIVACY — FIXED_PENDING_TARGET_PROOF**: persisted/live reasoning
  parts are audit-only and Web renders only lifecycle, typed commentary,
  approval, and tool activity. Legacy providers that prefix terminal output
  with third-person user narration or internal planning are quarantined as
  reasoning, which produces typed `MODEL_FINAL_MISSING` rather than exposing
  deliberation.
- **TOOL-DISCLOSURE — FIXED_PENDING_TARGET_PROOF**: a local browser run showed
  `Waiting for approval`, resumed after `Allow once`, completed `pwd`, and
  replayed an expandable `Ran pwd` disclosure with command, cwd, sanitized
  output, and `Success`. The row expansion state contract was also corrected
  after the disclosure test exposed a double inversion.
- **INC-002 / Plan 045 — FIXED_PENDING_TARGET_PROOF**: scope remained limited
  to release-blocking admission wiring. `gate:cloudflare-capacity` proves Brain
  admission and deployed container `max_instances` are both `2`; capacity
  exhaustion is typed as `RUN_CAPACITY_EXHAUSTED`. No Sandbox SDK RPC migration
  or unrelated Plan 045 feature work was started.
- **RF-023 — OPEN, P1 local-dev migration blocker**: a fresh local Brain state
  cannot apply the canonical v5 deleted-class migration because Wrangler
  reports `Cannot apply deleted_classes migration to non-existent class
  SessionMemoryRuntime`. Existing ignored local state can boot without that
  migration, but the checked-in canonical local-start validation still needs a
  fresh-state-safe migration sequence before release.
- **RF-024 — OPEN, P1 historical privacy debt**: transcript rows persisted as
  visible finals before the new provider quarantine remain visible on replay.
  New turns are protected at ingress, but existing stored rows need an explicit
  retention/migration decision; this repair does not rewrite append-only
  history.

Focused evidence: Web activity/chat tests `52/52`, Brain controller/runtime/
execution tests `43/43`, execution-engine final/privacy tests `12/12`, protocol
identity tests `3/3`, Web/Brain/execution-engine typechecks,
`gate:cloudflare-capacity`, `gate:runtime-conformance`, architecture boundaries,
and `git diff --check` pass. Browser proof covered greeting final, filesystem
search/read activity, approval, shell disclosure, and completed replay.

### Required release proof

Run the authenticated target-dev product gate for greeting/read, edit approval,
reload/follow-up, concurrent isolated chats, terminal lease release, and
credential-safe logs. Do not change the statuses above to `CLOSED` until that
gate produces sanitized evidence for each flow.
