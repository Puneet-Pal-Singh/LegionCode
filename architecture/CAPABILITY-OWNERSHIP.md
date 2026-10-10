# Capability ownership

## Plan 058.1 — Canonical turn-patch read model

| Responsibility | Canonical owner | Active producer and consumers |
| --- | --- | --- |
| Saved turn diff payload and identities | Existing runtime artifact/lifecycle path and `platform-protocol` | Existing SDK lifecycle/diff queries supply `TurnDiffPayload`; ownership is unchanged. |
| Pure saved-patch parsing into `DiffContent` | `packages/sdk/src/platform/turn-diff-patch.ts`, exported by `@legioncode/sdk` | Web `WorkflowTimeline`, `useCompletedTurnReview`, `changedFiles`, and `useChangedFilesController` consume the same parser. |

The Web `services/lifecycle/TurnDiffPatchParser.ts` implementation and its test
are moved to SDK; no compatibility copy remains. Algorithm, function signature,
shared diff types, rendering, and missing-file `null` behavior are unchanged.
The existing parser tests move with the implementation; no safeguards are
removed. Completed review continues to use the canonical saved patch.

## Plan 058.2A — Message markdown and actions

| Responsibility | Canonical owner | Active consumers |
| --- | --- | --- |
| Message markdown, mention presentation and assistant change-count stripping | `client-ui/src/conversation/chat-message` | Web ChatMessage, WorkflowTimeline and useMessageDisplayContent use the shared implementation. |
| Copy/edit controls, metadata labels and hook audit popover | `client-ui/src/conversation/chat-message/MessageActions.tsx` | Web ChatMessage supplies presentation metadata, canonical SDK hook audits and edit callback. |
| Message presentation metadata type | `client-ui/src/conversation/chat-message/types.ts` | Shared actions and Web metadata builders/ChatInterfaceView/ChatMessage. Metadata display derivation is shared in `client-ui/src/conversation/chat-interface`. |
| Class-name conflict merging | `client-ui/src/classnames.ts` | Shared renderers and all existing Web class-name callers. |

Old Web implementations are deleted; no compatibility copies remain. Existing
markdown and action tests move with their source. The existing popover style
moves into shared styles imported by both Web and Desktop. Shared presentation has no
Web imports or product HTTP/storage authority. Browser clipboard remains UI
behavior; authentication, runtime commands and metadata derivation are unchanged.

## Plan 058.2A — Image preview and composer drafts

| Responsibility | Canonical owner | Active consumers |
| --- | --- | --- |
| Image gallery/modal and attachment strip | `client-ui/src/conversation` | Web ChatMessage, ChatInputBar and AgentSetup render the shared source. |
| Browser image draft validation, file reading, preview URL lifecycle and submission detach/restore | `client-ui/src/conversation/useChatImageAttachmentDraft.ts` and `chatImageAttachments.ts` | Web composer/setup supply files and submission callbacks; existing submit/initial-intent bindings consume the same attachment types and transformations. |

Old Web files and the adjacent attachment-helper test are moved, with no
compatibility copies. Existing accept/reject cleanup, URL revocation, paste,
drop, Escape and gallery-navigation behavior is unchanged. Drafts remain local
UI state; submitted history and hydrated media authorization stay with their
existing server/Web bindings until the command/history slices.

## Plan 058.2D — Inline changed-file review presentation

| Responsibility | Canonical owner | Active consumers |
| --- | --- | --- |
| Changed-files card, stats, inline hunk context and asynchronous diff display states | `client-ui/src/conversation/chat-message` | Web ChatMessage renders supplied canonical files/diff loader and forwards the existing review callback. |
| Changed-file presentation types | `client-ui/src/conversation/chat-message/changed-files-types.ts` | Shared renderers and Web ChatMessage/useMessageDisplayContent consume the same type. |

Old Web renderers/helpers/types and the existing statistics test are moved and
deleted at their old paths. Data selection, artifact identity and immutable
saved-patch loading remain with existing SDK/Web owners until their operation
slice. Shared presentation invokes only the supplied loader; it owns no Git,
artifact transport or runtime state. Existing loading/error/missing-diff,
binary/no-line-change, known-stat preservation and hunk context behavior remain.

## Plan 058.2A — Shared message composition and artifacts

| Responsibility | Canonical owner | Active consumers |
| --- | --- | --- |
| ChatMessage, visible-content/redaction helpers and artifact preview presentation | `client-ui/src/conversation` | Web ChatInterfaceView renders shared messages for history and lifecycle entries, supplies existing image URL resolver and cold-storage loader. |
| Artifact-open callback types | `client-ui/src/conversation/artifactOpen.ts` | Shared message/artifact UI and Web workflow/conversation callers use the same type. |
| Hosted hydrated-image URL binding | Web `chatMessageImagePresentation.ts` | Existing scoped-path validation and Brain base resolution supplied explicitly to ChatMessage. |
| Existing cold-storage artifact transport | Web `services/ArtifactService.ts` until 058.3E | Existing Muscle artifact fetch supplied as callback; move required typed operation to SDK/App Server during the artifact operation slice, then delete this Web transport. |

Replaced Web message/rendering/helpers are deleted. Only active host URL/HTTP
bindings remain, with the artifact transport deletion trigger above. Existing
message integration safeguards stay at the Web boundary to cover its bindings.
No product HTTP/storage authority or Web imports enter shared presentation.

## Plan 058.2D — Full diff and review renderers

| Responsibility | Canonical owner | Active consumers |
| --- | --- | --- |
| DiffViewer, changed-file list, split/unified rows, collapsed context, selection and inline comment UI | `client-ui/src/review` | Web workflow, ChangesPanel, workspace content and sidebar tree render the shared source with supplied diffs/actions. |
| Local review draft types, prompt formatting/budget, anchor matching and diff fingerprint | `client-ui/src/review/reviewComments.ts` | Shared diff/comment renderers and Web review draft/submission bindings retain the same functions. Drafts are unsent UI data, not runtime settlement. |
| Visual review scope types/labels and dropdown | `client-ui/src/review/reviewScope.ts` and ReviewScopeDropdown | Shared changed-file list and Web review controls/resolver import the same visual declarations. Artifact selection/availability/identity stays in the existing Web resolver until its SDK operation slice. |
| Existing review leaf file icons/filter and code typography | `client-ui/src/review` | Shared review and all existing Web workspace/repository/artifact callers. |

All replaced Web renderers, helpers and four existing test files move with no
compatibility copies. Their module bodies and visual declarations are unchanged
after import normalization. Shared review owns no product HTTP, storage, Git or
artifact loading; Web supplies the same data/actions. Existing immutable saved
diff versus explicit live Git selection remains unchanged. No test is removed;
Web integration safeguards stay at their application boundary.

## Plan 058.2C — Workflow and approval presentation

| Responsibility | Canonical owner | Active consumers |
| --- | --- | --- |
| Canonical workflow surface/timeline, pending acknowledgement, clock/labels and disclosure | `client-ui/src/conversation/workflow` | Web ChatInterfaceView supplies the same SDK workflow projection and artifact-open callback. |
| Approval dock/actions, displayed-decision labels/styles | `client-ui/src/conversation/approval` | Web ChatComposerControls renders the shared dock; useApprovalController consumes unchanged displayed-decision selection and retains existing command ownership until 058.3D. |
| Read-file output envelope normalization | `sdk/src/platform/read-file-output.ts` | Shared workflow file preview and Web workspace useFileLoader consume the same parser. |
| Existing lifecycle shimmer and reduced-motion presentation | `client-ui/src/styles.css` | Shared workflow and existing Web turn status use the same moved CSS. |

Old workflow/approval presentation and parser copies are deleted after all
active callers migrate. Existing tests move with their source, using the same
client-ui browser-test setup pattern; no assertions are removed. SDK workflow
projection remains the canonical read model; shared UI has no runtime commands,
HTTP or product storage. Approval settlement and artifact loading stay with
existing owners until their command slices. Unused Web WorkflowPlanDiff and
explorationCopy are untouched; no unrelated cleanup or new input UI is included.

## Plan 058.2B — Composer and context controls

| Responsibility | Canonical owner | Active consumers |
| --- | --- | --- |
| Composer text/mentions, image drafts, submit/Stop presentation, mode/permission/context controls and warning UI | `client-ui/src/conversation` | Web ChatComposerControls uses WebChatInputBar to supply existing provider picker slots/preference and renders the shared ChatInputBar. AgentSetup uses the same moved mention/plus/image/permission controls. |
| Context usage/detail presentation and formatting | `client-ui/src/conversation/context` | Shared composer and Web workspace tabs/body/state supply the same canonical context/usage snapshots and session display data. |
| Current hosted provider/model/credential control binding | Web `useWebComposerProviderControls.tsx` and `WebChatInputBar.tsx` | Existing ProviderStore effects/actions, model/reasoning picker, notice/quota/dialog nodes and composer UI preference are supplied explicitly. Product operations remain pending 058.3B; migrate them through existing SDK/App Server owners and delete competing Web product authority then. |

The necessary host-binding commit precedes the mechanical move. The shared
renderer takes only narrow presentation slots and existing callbacks/data; it
does not receive a Web store/service object. All replaced Web renderer/leaf
copies are deleted. Existing composer integration tests stay at the Web binding;
permission, mention and context tests move with their implementation, preserving
assertions and native browser setup. Existing custom composer/plus-menu styles
move exactly into shared styles, with no old copies. UI preferences and unsent
drafts remain local UI state; submitted history/admission/Stop remain with their
existing owners until the command slices.

## Plan 058 baseline — Session transcript paging

| Responsibility | Canonical owner | Active consumers |
| --- | --- | --- |
| Authorized session transcript pages and committed snapshot watermark | Existing persistence TranscriptRepository and Brain TranscriptController | Web ChatHydrationService reads the same session-scoped contract, independent of execution-run filtering. |
| Validated complete/partial paginated reads | `sdk/src/platform/conversation-history.ts` | Web ChatHydrationService retains verified pages, rejects invalid identity/timestamp/cursor data, and no longer fabricates message identities or truncates after ten pages. |

This adopts only the pinned session-history portion of the incoming durability
fix from main. Existing browser hydration scope/live binding remains pending the
session-surface/admission adoption; it is not counted as completed saved-history
restoration. Admission-backed identity enrichment and its immutable binding
migration remain with the admission-writer slice, so no constraints are installed
before their writer is wired. Current Web HTTP history loading is temporary until
058.3A routes the typed operation through the authenticated hosted App Server;
then delete the Web fetch method. No product storage or migration is altered here.

## Plan 058 baseline — Durable admission and canonical transcript append

| Responsibility | Canonical owner | Active consumers |
| --- | --- | --- |
| Owned session/thread binding, idempotent prompt admission and execution claim | Existing PostgresTurnAdmissionRepository | Brain TurnController reserves identity; HandleChatRequest admits prompt/run atomically; RunEngineRequestHandler imports that identity and claims execution. |
| Assistant transcript deltas and terminal run/session settlement | PostgresLifecycleEventStore canonical append transaction | RuntimeKernel emits through the existing lifecycle store; TranscriptRepository reads the same committed projection and admission identity. |

The incoming durability implementation is adopted before client command extraction.
The obsolete runtime lifecycle wrapper, response transcript writer and unused
PersistenceService assistant writer are deleted. RuntimeEventProcessor retains
run-event/step projections but no longer independently settles run/session status.
Migration 0032 installs immutable thread binding, admission identity and canonical
transcript keys with the writer. Existing title and image policy remains in place.
SQL gates replace the removed writer tests with admission rollback/retry, canonical
append rollback/replay/deduplication, distinct turns, owner isolation and execution
claim/revision safeguards. New-session creation is awaited before publishing the
conversation to submit callers; canonical delta fragments retain exact whitespace
in subsequent model context. Browser admission binding remains pending the next baseline
slice; hosted command routing through App Server remains pending 058.3.

## Plan 058 baseline — Session conversation and delivery binding

| Responsibility | Canonical owner | Active consumers |
| --- | --- | --- |
| Submitted transcript and terminal state | Existing Brain admission, transcript and lifecycle append owners | Web reads verified session history independently of execution scope and renders SDK lifecycle projections, including partial replies. |
| Request acknowledgement and explicit delivery retry | Existing server admission identity; temporary Web submissionAttemptRegistry/submissionTransport binding | useChatCore and queued setup intent retain the exact reserved tuple, client message identity and serialized payload; only bound acknowledgements or canonical evidence confirm admission. |
| Mounted conversation and history recovery presentation | Web SessionConversationSurface and useChatHydration | Setup/workspace share one useChat owner for the selected session; partial/failed reads preserve verified rows, and stale reads cannot replace another session. |

The run-filtered message identity/visibility helpers and the component-local
initial prompt guard are deleted. Session metadata without an active execution
keeps a null run identity. Background authentication refresh retains the mounted
conversation. Existing meaningful transport outcome safeguards are retained,
including suites removed by the incoming baseline's unrelated test cleanup.
Browser product caches are preserved; no storage cutover or import is performed.
Request mechanics remain temporary Web bindings until 058.3C moves them into the
existing SDK, and history transport moves through authenticated App Server in
058.3A. Shared conversation composition remains pending 058.2E. The earlier
baseline entries' pending browser binding is fulfilled here, without claiming
completion of hosted routing or final browser acceptance.

## Plan 058.1 — Lifecycle projection composition and selection

| Responsibility | Canonical owner | Active consumers |
| --- | --- | --- |
| Compose workflow and hook-audit read models | SDK workflow/conversation-lifecycle-projection | Web active/historical replay, approval, conversation and terminal presentation use the moved composition of existing SDK reducers. |
| Select the newest observed/replayed/active projection per turn | SDK workflow/merge-lifecycle-projections | Web ChatInterface uses the same sequence/terminal/item tie-breaking rules. |

The Web composition and selection copies and their tests move and are deleted
at their original paths. No second reducer or lifecycle producer is added.
The existing SDK workflow applyLifecycleEvent export remains unchanged; the
composed function is named applyConversationLifecycleEvent to avoid collision.
Terminal wording and conversation presentation stay UI-local until 058.2E;
canonical saved-diff derivation and transcript grouping remain pending their
respective capability slices. Existing assertions and edge cases are retained.

## Plan 058.1 — Transcript identity and grouping

| Responsibility | Canonical owner | Active consumers |
| --- | --- | --- |
| Canonical turn identity, repeated-message collapse and exact assistant grouping | SDK platform/conversation-turns | Web conversation entries, metadata presentation and historical replay use the same grouping. |

Existing algorithms and their useful tests move; replaced Web functions are
deleted and every caller imports SDK. The grouping preserves each caller's full
message type through a narrow structural input, without depending on the AI UI
transport package. UI timing labels/debug metadata remain presentation-local.
Conversation entry visibility remains UI-specific until its shared view move.
No new HTTP, storage, reducer or identity inference is added.

## Plan 058.1 — Saved turn-diff file mapping

| Responsibility | Canonical owner | Active consumers |
| --- | --- | --- |
| Saved canonical turn-diff file mapping | SDK platform/conversation-turn-diff | Web inline/completed review and terminal presentation use the same mapping. |

The existing mapping and its useful test move; replaced Web function is deleted
and all callers import SDK. Unchanged/copied status normalization, missing stats
and unstaged presentation values are preserved. Terminal failed_runtime display
wording stays presentation-local; no canonical settlement is derived there.
No live Git fallback or artifact transport is introduced.

### Plan 058 conversation view host bindings

Web `ChatInterface` supplies image URL resolution, cold-storage loading and the
client debug panel to the conversation view. The view receives presentation
values/callbacks; authenticated transport and debug collection remain Web-owned.
No runtime, admission or hydration algorithm changes. This boundary permits the
existing view and presentation hooks to move into shared client UI next.

### Plan 058 conversation presentation helpers

`client-ui/src/conversation/chat-interface` owns transcript render entries,
message display metadata, terminal labels and changed-file summary presentation.
Web ChatInterface, the view/presentation hook and changed-files controller use
these shared helpers; SDK remains the canonical identity/projection/diff owner.
The replaced Web helpers/types and their tests are moved, preserving assertions.
The prompt-terminal capability gate executes the moved terminal display test.

### Plan 058 conversation presentation hooks

Shared client UI owns conversation visibility/loading, bottom-follow scrolling
and completed-turn review presentation over SDK projections. Web ChatInterface
and Workspace consume the shared hooks; request transport, authentication and
canonical lifecycle follow remain outside these hooks. Existing regressions
move with the implementations and retain their assertions.

### Plan 058 shared conversation surface

`client-ui/src/conversation/chat-interface/ChatInterfaceView.tsx` owns the
existing setup/history/active conversation renderer, composed from shared
message, workflow and composer surfaces. Web ChatInterface renders this source,
providing existing image/artifact callbacks and its debug panel. Network/auth,
provider selection and lifecycle subscription orchestration remain Web host
bindings pending their SDK operation slices. The old Web view is deleted.

### Plan 058 hosted conversation history application

`brain/src/integration/app-server/HostedConversationHistory.ts` composes the
existing transcript repository and revision projection for server-authenticated
readers. The HTTP controller delegates to this owner during the App Server/SDK
cutover; the old route is deleted when its Web reader migrates in this slice.
The snapshot, message/image metadata and ownership algorithms are preserved.

### Plan 058 authenticated App Server history

The existing App Server dispatches `session/history` using the canonical
ConversationHistory request/response schemas (real UUID session identity).
Brain composes its existing history/repository owner only after cookie auth;
resource reads scope to the verified user and return explicit missing/unavailable
states. Local Thread/workspace semantics are unchanged. Web cutover follows.

### Plan 058 SDK conversation history operation

The existing SDK AppServerClient exposes the validated `session/history` page
operation. Its existing HTTP transport supports hosted cookie credentials and
explicitly disabling its default deadline so existing cancellable history reads
keep their lifetime. No second public client, history loop or projection exists.
Web will use this operation with the existing SDK pinned-page reader.

### Plan 058 Web history cutover

Web ChatHydrationService uses the existing SDK AppServerClient page operation
through the authenticated hosted composition, with the existing pinned-page SDK
reader and Web-only message presentation conversion. Cancellation, partial/failed
reads and complete-snapshot replacement retain their existing safeguards.
The unused Brain `/api/chat/history?session=...` route/controller and Web URL
builder are deleted; the separate secure-agent-api run-history route is outside
this session read and unchanged. No browser storage is deleted or migrated.
