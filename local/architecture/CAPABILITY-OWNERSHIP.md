# LegionCode Capability Ownership

## Purpose

This ledger protects valuable behavior while LegionCode converges on the runtime
architecture defined in `RUNTIME-ARCHITECTURE.md`.

Update a row in the same PR when its canonical owner, active producers,
consumers, migration state, replacement, or deletion trigger changes. Do not
mark a capability canonical because a package or interface exists; it must be
wired into the real product path.

Status meanings:

- **Canonical**: one active owner; real producers and consumers use it.
- **Transitional**: canonical target exists but competing owners or consumers
  remain.
- **Broken**: active product contract is known not to work end to end.
- **Planned**: target is defined but not wired into the product path.

## Active Ownership Ledger

| Capability                                      | Current active owner(s)                                                          | Canonical owner                                               | Active consumers                               | Status       | Required replacement or deletion trigger                                                                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub-first activation and onboarding          | Brain auth/access policy, GitHub repository grants, durable workspace selection, provider credential service; Web projects those server states into the sign-in, authorized repository picker, and contextual provider prompt | Control-plane auth and workspace selection plus runtime workspace readiness events; Web presentation only | Web; future Desktop/CLI through the SDK read model | Transitional | Wire the runtime workspace-manifest/readiness query into Brain and the public SDK product path, then render the canonical repository handshake in Web. Required-step localStorage authority and the duplicate login/setup overlay paths have been deleted; never replace them with client timers or inferred progress. |
| Turn/tool/approval/artifact lifecycle           | Runtime kernel lifecycle coordinator through `RunEngineKernelLifecycleEventStore` | Runtime kernel through platform protocol                      | Brain durable store, SDK replay/continuation, Web workflow surface | Canonical for Plan 049 | Legacy RunEvent records remain only for non-workflow compatibility endpoints; delete those endpoints when their consumers are migrated |
| Live lifecycle delivery                         | Durable lifecycle store replay; Brain lifecycle stream adapter and public lifecycle stream route deleted | Lifecycle store replay plus SDK polling continuation            | SDK and Web lifecycle projection                       | Canonical | No lifecycle websocket/stream authority; the deleted `/lifecycle-events/stream` contract must not be reintroduced; continuation must end only on a durable terminal event |
| Transcript and refresh reconstruction           | Brain lifecycle append callback buffers one turn-scoped assistant transcript and persists it once at terminal settlement; authenticated chat admission reloads the durable transcript and failed-turn lifecycle outcomes before runtime handoff; TranscriptController metadata hydration | Canonical lifecycle replay plus persisted transcript identity | Runtime context input, Web transcript hydration, and SDK lifecycle replay | Canonical for Plan 049 | Delete any remaining activity/RunEvent transcript reconstruction consumer; clients must never decide model-visible history from their hydration timing |
| Turn status and interruption                    | Runtime interrupt registry, native runner, kernel terminal settlement, and authenticated secure-runtime task cancellation | Runtime command plus terminal lifecycle projection; execution cancellation remains owned by the secure backend lease | Web Stop through SDK interrupt operation; Brain runtime; secure agent API; Web workspace/sidebar derived from the active SDK projection | Canonical for Plan 049 | Delete local status/stop authority and run-summary fallback; every accepted stop must settle exactly one `turn.interrupted` after provider/tool/backend cancellation |
| Workflow, thinking, activity, tool presentation | Runtime records only provider-emitted visible commentary; tools emit their own typed lifecycle items; SDK `TurnWorkflowProjection` + `groupToolActivity`; focused Web renderers under `components/chat/workflow` | Lifecycle item projection in SDK/client projection package | Web active-turn and settled-turn rendering through one shared lifecycle follower, keyed only by canonical turn identity | Canonical for Plan 049 | Delete remaining active consumers of `ActivityFeedViewModel`/RunEvent workflow projections; never synthesize assistant commentary from tool labels or expose hidden chain-of-thought; client renderers must not create another lifecycle subscription, alias one turn's projection to another turn, or infer missing runtime state |
| Approval continuation                           | Runtime kernel approval lifecycle and Brain approval command                              | Runtime kernel and permission policy                          | Web SDK approval request/decision/replay          | Canonical for Plan 049 | Delete client-owned approval status and any approval resolution fallback                          |
| Completed-turn review and diff                  | Finalized turn artifact/diff lifecycle projection; explicit live Git review remains a separate user-selected scope                                           | Finalized turn artifact projection backed by Git/artifact service       | Web settled-turn review; explicit live Git review actions only | Transitional | Artifact baseline/final capture reuses the checkout-bound secure execution session after workspace bootstrap; migrate `ChangedFilesController` and any completed review consumer to finalized artifact only; no passive live-Git probe or fallback may run when a canonical completed turn exists |
| Scope and refresh reconstruction                 | Brain `GET /turn/scope` read boundary backed by durable turn identities | Brain admission/control plane plus platform `TurnScopeBootstrap` contract | Web scope resume after validated canonical transport ids hydrate, transcript hydration, SDK replay | Canonical for Plan 049 | Delete any client-created scope on reload; reconstruction must remain read-only, must not create a turn, and must never issue a partial, placeholder, or legacy-id request |
| Workspace execution                             | Brain issues one persisted task checkout per complete workspace/thread/turn/run-attempt identity; secure cloud runtime binds every tool, Git operation, and artifact capture to that checkout root | Runtime workspace authority behind execution backend contract | Runtime tools and checkout-bound Git/artifact service; explicit user-opened live review may read status | Transitional | Remove remaining duplicate workspace-state decisions; artifact capture must reuse the canonical secure session; model-supplied file hashes are not workspace authority—runtime preflight and atomic backend checks own mutation concurrency; never restore automatic setup/chat/top-nav Git probes |
| Cloud execution backend                         | Secure agent API cancel/execute routes and worker/runtime contracts; Brain admission is exactly three concurrent chats per user/workspace/platform while deployed sandbox capacity retains recovery headroom | Cloud implementation of execution backend/worker protocol     | Runtime kernel through Brain ExecutionService | Transitional | Move every tool and interrupt path through the backend contract; delete bypasses and stubs; keep runtime instance capacity above the admitted three-run floor |
| Desktop local execution                         | None in canonical product path                                                   | Local implementation of the same execution backend contract   | Future Desktop through SDK/runtime             | Planned      | Implement only after cloud path and backend contract are canonical; do not fork lifecycle or tool policy                                       |
| Client SDK                                      | Platform client SDK: lifecycle replay/continuation, workflow projection, interrupt request | Public `@legioncode/sdk` over platform protocol               | Web first; future Desktop/CLI/Mobile           | Transitional | Migrate remaining Web lifecycle HTTP calls behind SDK transport and complete public package cutover; Plan 049 Web lifecycle calls already use this SDK facade |
| Context assembly                                | Brain supplies authenticated durable transcript/lifecycle replay as input; runtime context preparation owns instruction, budget, and compaction policy | Runtime Context Engine                                        | Model/harness gateway; lifecycle budget projection | Canonical for Plan 049 | Client message arrays are admission evidence only, not conversation-history authority. Context window facts come from provider/model metadata; unavailable facts remain unavailable |
| Context compaction                              | Runtime kernel context compaction coordinator and injected compaction port emit one typed lifecycle state machine | Runtime Context Engine with one compaction item/state machine | Model/harness gateway, SDK replay/projection, Brain command routing, Web threshold-gated `/compact` command | Canonical for Plan 049 | Keep legacy persistence pruning out of lifecycle/workflow ownership; manual and automatic compaction must use the same runtime owner and durable lifecycle projection |
| Token allocation and model-context usage        | Brain resolves known context limits from the provider catalog; runtime gateway enriches measured usage with canonical pricing resolution and runtime context projection reconciles provider-reported total tokens | Runtime Context Engine and provider catalog                    | Durable lifecycle, SDK usage/context projection, Web composer disclosure and Context details tab | Canonical for Plan 049 | Provider-reported usage is preserved; known model limits come from the server catalog instead of optional client input; unavailable context/cost values remain explicit and are never estimated in Web; the client visibility preference controls rendering only |
| Provider/model integration                      | Provider services/catalog plus runtime gateway; discovered per-model routes are trusted by chat admission for mixed-transport providers; OpenAI-compatible transports preserve their logical provider identity | Provider catalog and narrow provider/model adapter            | Runtime Context Engine, kernel, and Web provider projection | Transitional | Connected provider inventories are preloaded into picker/manage projections after bootstrap; mixed-transport OpenCode Zen and Cloudflare routes come from enriched catalog records, never model-name guesses. Remove provider decisions and auxiliary title inference from turn admission; transport compatibility must never rewrite logical provider identity; make capability and usage reporting adapter contracts |
| Harness adapters                                | Brain harness port and runtime-specific integration code                         | Runtime Harness Adapter port                                  | Runtime kernel                                 | Transitional | Prove one adapter end to end; map events, usage, approvals and interruption without owning lifecycle or persistence                            |
| ACP and future Codex/Claude harnesses           | No canonical product implementations                                             | Harness Adapter implementations                               | Runtime kernel and SDK clients                 | Planned      | Add adapters behind the canonical harness port after lifecycle/context contracts are stable                                                    |
| Tool registry and execution policy              | Execution-engine registry plus remaining adapter/tool surfaces                   | Tool registry plus permission policy invoked by kernel        | Harness/model loop and execution backend       | Transitional | Route all tools through registry, policy and backend ports; delete duplicate schemas and direct execution                                      |

## Required PR Update

An architecture-sensitive PR must state:

1. Product responsibility.
2. Current owner or owners.
3. Canonical owner after the change.
4. Active producers migrated.
5. Active consumers migrated.
6. Code or path removed.
7. Replacement for removed behavior.
8. Remaining duplicate authority, with owner and deletion trigger.

If no ledger row changes, say why the change preserves existing ownership.

## Ledger Rules

- This file describes ownership and wiring, not task progress or dates.
- Do not create a second ledger in a plan, issue, or package README.
- Detailed implementation summaries belong in PR descriptions.
- A temporary flag or adapter is not a canonical owner.
- A projection is never the owner of the state it renders.
- “No imports found” means disconnected until real-path wiring is demonstrated.
- Delete a row only when the capability is removed from product scope. Keep
  canonical capabilities documented so future work knows where to extend them.
