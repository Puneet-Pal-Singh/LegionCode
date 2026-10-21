# Capability ownership

## Project selection and projectless chat

| Responsibility | Canonical owner | Active wiring and invariant |
| --- | --- | --- |
| Saved session repository | Brain transcript/session repository | Session creation accepts `repository: null`. Migration `0034_projectless_session_repository` normalizes the old `New Project` label. No new sentinel repository is written. |
| Active chat repository context | Selected session metadata, projected by Web App | Explicit project selection and the selected session's GitHub context supply repository/branch identity. Global browser context restoration and workspace-selection bootstrap are removed; a null repository cannot match a repository context. |
| Projects and Recents | Sidebar selectors over saved session metadata | Real repositories group project chats; projectless, unarchived, unpinned chats appear in Recents. Pinning, search, status and archive use existing session projections. |
| Project onboarding | Existing authorized workspace selection service | The compact dialog stages repository and branch locally. Only Add project confirms selection. Closing or searching never selects a repository. Unsent text/images transfer through UI draft state on an explicit choice. Sidebar Add project reads the mounted composer through its draft reader port before switching sessions; the composer remains the unsent draft owner. The modal is portaled to the viewport with focus isolation and a light backdrop blur. Home keeps the centered composer and dynamic project/settings island; section expansion is local UI state. |

Projectless **execution remains an open migration**: `TaskCheckoutIssuer` requires
an authorized repository snapshot, and native runtime manifests currently require
Git workspace identity. Projectless session persistence and navigation do not
remove that requirement. The next runtime slice must support an explicit
conversation-only execution capability through the existing admission, kernel,
lifecycle and transcript owners, without fabricating a repository, Git tree,
checkout, or alternate chat transport. Its deletion trigger is removal of the
unconditional checkout requirement for an admitted projectless session, proven
by send -> terminal lifecycle -> saved history -> reload and Stop/continuation.

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

## Conversation durability

| Responsibility                                          | Canonical owner                                  | Producers and consumers                                                                                                                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Saved conversation ownership and stable thread identity | Postgres session repository                      | Brain history reads are scoped to the authenticated session; missing runtime scope does not hide saved messages.                                                                                                        |
| Turn identity and execution admission                   | Postgres `canonical_turn_admissions`             | Brain reserves the exact request tuple and commits its prompt/run atomically. Authenticated scope reads retain the exact admitted identity during recovery; runtime claims that tuple once, and local identity caches are reconstructable. |
| Logical task context and continuation history           | Canonical admission lineage and lifecycle events | Brain restores the original prompt, image references, accepted steering, and named tool batches. The execution engine preserves that logical root through provider requests and compaction; revisions exclude the superseded branch from model input while retaining saved history. |
| Stopped workspace progress                              | Runtime artifact settlement through the existing Git service | Canonical lifecycle artifacts identify an immutable, scoped R2 patch. Resume restores it into a fresh checkout and verifies the terminal tree before execution. Missing or unverified progress produces an explicit unavailable state. |
| Pending conversation commands                          | Postgres `thread_inputs` and canonical turn admission | Authenticated Brain commands store versioned queue items with captured content and configuration. Admission claims a queued prompt atomically; successful completion may drain the queue, while Stop or failure pauses it. Queue rows do not own turn or approval status. |
| Steering delivery and receipts                         | Runtime kernel lifecycle append transaction      | The live runtime accepts input for an exact turn and attempt, then applies it at a complete tool-batch boundary. The canonical append transaction projects acceptance, transcript, and delivery receipts together; clients reconcile those receipts through the SDK. |
| Composer delivery preferences                          | Web composer preferences                         | Plain text display, context usage visibility, send shortcut, and Queue/Steer defaults are UI preferences. SDK commands carry immutable captured submissions; local preferences do not replace durable queued input or runtime state. |
| Pre-kernel startup failure and orphan Stop settlement   | RuntimeLifecycleCoordinator through the Brain runtime adapter | A captured execution claim may settle only an admitted matching tuple with zero lifecycle history. An orphan Stop requires no locally owned startup, handler, or approval resolver. It accepts either zero history on a recovery-required admission, or complete kernel-validated history proving a single pending approval/tool gate. One atomic canonical append cancels approval and interrupts open work; tools are never replayed and execution claims are never reset. |
| Approval denial continuation                             | Runtime kernel approval and tool coordinators    | A durable denial is delivered to the matching active tool call once. Worker/provider refusal, cancellation, timeout, or a missing owner never substitutes for the user's decision; terminal settlement remains a canonical runtime event. |
| Recovery status and user-facing error presentation      | Authenticated turn-scope reader and thin Web adapter | Recovery does not hide the admitted identity. The client keeps typed delivery/runtime errors actionable and reconciles setup from durable admission and lifecycle state instead of owning session-failed status. |
| Assistant transcript and terminal status                | Canonical lifecycle append transaction           | Runtime events, assistant transcript parts, and session/run terminal status commit together. History and context assembly consume durable rows. The append path does not rebuild the unused full-turn projection cache. |
| Delivery confirmation and explicit retry                | Web `useChatCore` and its observed-fetch adapter | The SDK parses transport output. Exact HTTP tuple acknowledgement or canonical lifecycle evidence confirms admission. Unconfirmed retries retain the original client identity and serialized payload.                   |
| Session save readiness and queued setup intent          | Web session manager and App's per-session queue  | Workspace waits for a saved session and claims queued intent synchronously. Settlement is guarded by session/submission ID; unconfirmed delivery requires explicit retry.                                               |
| Saved transcript and history replacement                | Session-owned `useChat` with `useChatHydration`  | Complete snapshots replace verified rows; partial reads preserve previous rows. Only the pending user message is optimistic. SDK transport frames do not overwrite verified history.                                    |
| Completed-turn review source selection                  | Canonical turn diff from the lifecycle projection | Current and historical terminal cards select their exact completed turn; the session-scoped Web review provider renders and loads that selected canonical diff in the sidebar. |
| Live and partial assistant presentation                 | Canonical lifecycle projection rendered by Web   | Assistant text is rendered before terminal settlement and retained after failure/interruption. Exact turn/item/phase matching suppresses modern saved rows; historical final rows without item IDs require an exact completed-final text match, and historical commentary rows require an exact completed commentary concatenation match. |
| Setup selection                                         | `SessionConversationSurface`, keyed by session   | History loads before choosing setup. Only a complete empty read with no pending intent selects setup; run changes do not replace the history owner.                                                                     |
| Authenticated shell continuity                          | Web `App` shell, gated by `AuthProvider`'s initial authentication resolution | `AuthProvider` gates initial authentication only. `App` keeps saved chats mounted during background auth refresh and repository-context repair; header repository actions wait for context matching the active session. |
| Local worker persistence location                       | Existing local launchers                         | Both launchers pass an explicit absolute `LEGIONCODE_LOCAL_PERSIST_DIR` to Wrangler. Starting a worker does not clear or migrate existing state.                                                                        |

Manual historical imports and custom local writer supervision are excluded from
this change. Their preserved operator copies are not part of the active product
path. Unknown historical turn identity remains unset; opening saved history does
not require fabricating or importing runtime identity.

## Image context and compaction ownership

This ledger records the active wiring for image-bearing conversation context.

| Responsibility                           | Canonical owner                                                   | Active producers and consumers                                                                                                                                                               | Replacement and invariant                                                                                                                                                                                                                                                |
| ---------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Durable image identity and bytes         | Authenticated transcript references and `ChatMediaStore`          | Chat admission persists image bytes; transcript hydration renders references; durable context assembly resolves bytes for runtime input                                                      | Object keys use authenticated user/session scope and opaque attachment IDs. Missing, malformed, or mismatched media fails explicitly. Neither thumbnails nor redacted text markers substitute for provider image content.                                                |
| Text-only prompt revision                | Transcript persistence using the server-issued revision identity  | Web revision admission, persisted user message, active transcript branch, subsequent runtime requests                                                                                        | Inherit attachment references from the original user message in the same authenticated session. Client reloads do not require image re-upload. Superseded messages remain durable but are excluded from active model history.                                            |
| Provider context assembly and compaction | Runtime Context Engine through kernel context ports               | Durable admission supplies history; native provider transcript supplies live tool calls/results; `NativeRuntimeContext` assembles budgets and compaction; gateway consumes selected messages | Both ports read the same live provider transcript. Compaction preserves system instructions, historical image inputs, the original active task prompt, accepted steering, and its complete tool sequence. The stale admission-array compaction path and latest-user-only filtering are removed. |
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

## Approval delivery and PR-review reliability

| Responsibility                           | Canonical owner                                         | Active wiring and invariant                                                                                                                                                                                                                                                                                |
| ---------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lifecycle reconnection and cursor resume | SDK lifecycle continuation                              | Web uses typed transient retries for atomic initial replay and live following; stopped delivery exposes an explicit retry action. Approval truth remains the durable lifecycle log.                                                                                                                        |
| Authenticated GitHub PR review reads     | Coding tool registry and GitHub connector               | PR list/get/files/check tools use the existing authenticated connector. Latest-merged selection proves order or reports partial results; bounded file/patch windows expose continuation and unknown patch availability explicitly.                                                                         |
| Repository PR-read reuse                 | RegistryToolAuthorization and canonical approval grants | An explicitly offered grant binds the trusted authenticated user, chat, workspace and normalized repository. Existing lifecycle grant persistence is reused. Writes, shell, other repositories and old exact-input grants cannot consume the new matcher.                                                  |
| Pre-execution rejection recovery         | BashPlugin validation and native kernel worker          | Structured rejection proves execution did not start. One same-rule correction may return through the existing recoverable tool-result path, with normal validation/approval on every call. Exhaustion settles one canonical failed outcome explaining incomplete work.                                     |
| Composer provider/model preference       | ProviderStore and its session preference adapter        | ChatInputBar, AgentSetup, ProviderDialog and useChatCore share a stable session choice independently of the execution run. Cache is a browser preference only; submission uses the validated resolver and captures the admitted configuration. Inventory refresh cannot silently replace explicit choices. |

No lifecycle, grant or chat database migration is required. The old run-keyed
composer preference cache and direct unvalidated submission shortcut are removed
from the active path. Active turns retain their admitted provider configuration.
