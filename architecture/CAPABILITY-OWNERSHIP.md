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
