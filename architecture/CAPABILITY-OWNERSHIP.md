# Capability ownership

This entry records the title, workflow display, conversation durability, and
image-context boundaries changed by this work.

| Responsibility                                      | Canonical owner                                            | Producers and consumers                                                                                      |
| --------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Initial automatic title eligibility                 | Brain `scheduleInitialThreadTitle`                         | `HandleChatRequest`, after the first user message and its run are persisted                                  |
| Title inference                                     | Brain `ThreadTitleGenerationCoordinator`                   | Frozen first-run provider/model, existing provider adapters; bounded background job                          |
| Title, version, and pending/ready/failed settlement | Brain `ThreadTitleService` through `ThreadTitleRepository` | Atomic session update and `thread.title.updated` event; user rename supersedes automatic results             |
| Reload and live title display                       | Session and thread projections                             | Web renders persisted metadata and canonical events; it does not infer pending state from the preview source |

Migration `0031_session_title_status` adds durable settlement to session reads.
Existing rows become ready. New previews become pending only when a background
job is scheduled; unsuccessful jobs remain previews and settle failed.
Web refreshes this projection once when the canonical workflow starts, then
uses its existing bounded pending-title polling. A long chat response does not
delay the first title read; Web still does not manufacture title state.

The existing platform OpenRouter free route remains a coordinator-owned,
sanitized fallback for a failed selected route. No new provider fallback is
introduced. Remove it when an explicitly configured title route replaces this
behavior for all supported providers; selected-route success and failure tests
must then pass without fallback calls.

The prompt and validation adapt the small title patterns in
[Codex OSS](https://github.com/openai/codex/blob/67727e7cf114cf3e1b71db368d74b24e32f6cb12/codex-rs/tui/src/app/thread_title.rs)
and [OpenCode OSS](https://github.com/anomalyco/opencode/blob/2fa3363c924c5c3e367b84a87ae478296a0ed59b/packages/opencode/src/agent/prompt/title.txt):
short task wording, examples, bounded input, one output title, and manual name
precedence. Codex's public CLI source is the reference here, not its desktop app.

## Workflow activity and request history

| Responsibility                                            | Canonical owner                           | Producers and consumers                                                                                                                                                                                              |
| --------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approval and user-input request, response, and settlement | Runtime lifecycle events                  | SDK replay retains questions and recorded decisions/answers; Web renders history and its existing approval dock                                                                                                      |
| Live parent activity status                               | SDK `buildActiveWorkflowTrace` projection | Pending canonical requests take priority, followed by active tools and provider-designated display-safe reasoning summaries; Web renders the resulting state                                                         |
| Provider summary status text                              | SDK visible reasoning title helper        | Latest usable visible summary line, adapting [Codex OSS streaming status](https://github.com/openai/codex/blob/main/codex-rs/tui/src/chatwidget/streaming.rs); full commentary and reasoning remain transcript items |

The generic status is `Thinking`. Clients neither generate status sentences
nor store request decisions separately. A canonical decision or response settles
only its matching request, and terminal events close unresolved request history.
No question tool, response API, or approval owner is introduced by this display
change; adapters must emit the existing canonical user-input events for question
history and its waiting status to appear.

## Conversation durability and local recovery

| Responsibility | Canonical owner | Producers and consumers |
| --- | --- | --- |
| Conversation existence, ownership, and stable session-to-thread binding | Postgres session repository | Brain reads and writes; SDK/Web consume the owned conversation contract; runtime identity caches are reconstructable |
| Turn and attempt identity admission | Postgres `canonical_turn_admissions` through the Brain admission repository | Brain admission supplies exact identity to runtime; the existing canonical lifecycle append path validates it |
| Durable transcript and terminal projections | Postgres transcript projection in the canonical lifecycle append transaction | Runtime emits lifecycle items; transcript history and session/run reads consume the projections |
| Active execution leases and runtime-local identity cache | Durable Object runtime | Brain forwards authenticated commands; cache loss never changes saved conversation or turn identity |
| New-session save readiness and queued setup prompt delivery | Web session manager and existing initial-prompt claim owner | Workspace waits for successful session saving; failed delivery stays blocked across rerenders/remounts until explicit retry with the same client message ID; PostgreSQL admission owns execution idempotency |
| Historical recovery and local state admission | Operator-run Brain recovery CLI and local-dev preflight | Recovery reads copied SQLite roots and Postgres, writes per-session Postgres checkpoints; local launch binds one database fingerprint to explicit worker persistence roots |

The recovery CLI is dry-run by default. It imports a runtime tuple only when
the read-only SQLite source contains the same `turnRuntimeIdentities` and
`turnToRunMap` values, the database run and session have one owner and workspace,
and the original user message carries the exact client message id. Legacy chats
without that proof receive a stable provenance-marked thread binding only;
they do not receive fabricated turns, assistant replies, or lifecycle events.
Transcript identity candidates require exact item/phase and text evidence, and
ambiguous candidates remain unresolved. Local status divergence without an
attributable terminal event remains an unknown historical outcome. Artifact
bytes are marked verified only when the local object, size, and hash match its
database reference; remote bucket/provider migration remains a production gate.

Each local worker is launched with an explicit
`LEGIONCODE_LOCAL_PERSIST_DIR`. A sanitized database fingerprint and Durable
Object binding/migration fingerprint bind the root to its database and worker
configuration. Per-role PID/start/token and process-group locks reject a second
live writer. Both launchers use one waiting supervisor; the actual worker starts
only after its group is durably attached to the exact lock token. An atomic
mutex serializes acquisition, attachment, reclaim, and release. Reclaim and
release require proven dead writer groups; unknown or malformed evidence blocks
startup. CLI entrypoint paths are canonicalized before preflight runs. An
unmarked non-empty state root or identity mismatch blocks startup with
remediation; recovery never clears a persistence directory.
## Image context and compaction ownership

This ledger records the active wiring for image-bearing conversation context.

| Responsibility                           | Canonical owner                                                   | Active producers and consumers                                                                                                                                                               | Replacement and invariant                                                                                                                                                                                                                                                |
| ---------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Durable image identity and bytes         | Authenticated transcript references and `ChatMediaStore`          | Chat admission persists image bytes; transcript hydration renders references; durable context assembly resolves bytes for runtime input                                                      | Object keys use authenticated user/session scope and opaque attachment IDs. Missing, malformed, or mismatched media fails explicitly. Neither thumbnails nor redacted text markers substitute for provider image content.                                                |
| Text-only prompt revision                | Transcript persistence using the server-issued revision identity  | Web revision admission, persisted user message, active transcript branch, subsequent runtime requests                                                                                        | Inherit attachment references from the original user message in the same authenticated session. Client reloads do not require image re-upload. Superseded messages remain durable but are excluded from active model history.                                            |
| Provider context assembly and compaction | Runtime Context Engine through kernel context ports               | Durable admission supplies history; native provider transcript supplies live tool calls/results; `NativeRuntimeContext` assembles budgets and compaction; gateway consumes selected messages | Both ports read the same live provider transcript. Compaction preserves system instructions, historical image inputs, and the latest user message with its complete tool sequence. The stale admission-array compaction path and latest-user-only filtering are removed. |
| Context token estimates                  | Runtime context budgeting; measured usage belongs to the provider | Context assembly, compaction, provider usage reconciliation, lifecycle budget projection                                                                                                     | Image encoding is excluded from text estimates and receives a separate visual-input allowance labeled as an estimate. Provider-reported usage supersedes estimates. Retained tools and images remain included in post-compaction estimates.                              |
| Compaction settlement and continuation   | Runtime kernel through the canonical lifecycle append path        | Manual and automatic compaction, provider continuation, lifecycle replay                                                                                                                     | The complete summary obeys the protocol size limit and excludes structured image bytes. Provider usage updates preserve the active compacted context. Summaries are bounded excerpts, not model-generated visual descriptions.                                           |

## Verification and limits

- `ChatImageDelivery.integration.test.ts` exercises authenticated admission,
  durable media restoration, JSON handoff, native provider requests, recall,
  text-only revision, automatic/manual compaction, tools, and terminal replay.
- `NativeProviderContextMessages.test.ts` verifies image-safe estimates and
  summaries, protocol bounds, retained instructions, and paired tool progress.
- `ChatMediaStore.test.ts` covers scoped media identity and validation.
- Brain `ChatImageSettings` and `ChatImageNormalizer` own full decoding and
  provider normalization. They validate dimensions before decoding, serialize
  upload decoding, free WASM allocations, and preserve original R2 bytes.
  PNG, JPEG, WebP, and GIF fixtures prove decoding; corrupt files, pixel bombs,
  resizing, and encoded-size limits have focused regression coverage.
- Model discovery owns trusted image capability metadata. Chat admission and
  durable context assembly reject unsupported or unknown image input before
  provider dispatch, including text-only recalls of stored attachments.
- Historical image messages retain only their image parts after compaction;
  their text belongs to the bounded summary. The latest user message and live
  tool pairs remain intact. Long image captions/logs therefore cannot be copied
  back into compacted context in full.
- No alternate image store, client-owned history authority, compatibility
  fallback, or separate compaction lifecycle is introduced.
- The PR-required `image-context` capability check, owned by Brain chat ingress,
  runs the admission/media/model/provider and native context regressions above.
  Its invariant is that validated visual input survives revision and compaction
  while historical text stays bounded. Review this test set when those canonical
  owners or provider handoff contracts change; do not duplicate it in other gates.
- Compaction does not evict image inputs or active-turn tool pairs. Those retained
  inputs can exceed a small model's context budget; estimates must report that
  occupancy without claiming compaction freed it.
