# Capability ownership

This entry documents the chat title boundary changed by this PR. It does not
describe unrelated runtime capabilities.

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
- No alternate image store, client-owned history authority, compatibility
  fallback, or separate compaction lifecycle is introduced.
- Compaction does not evict image inputs or active-turn tool pairs. Those retained
  inputs can exceed a small model's context budget; estimates must report that
  occupancy without claiming compaction freed it.
