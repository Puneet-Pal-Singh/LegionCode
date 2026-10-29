# Capability ownership

## Main integration — shared conversation and continuation

Incoming main approval/recovery, workflow, steering, queue and continuation behavior
is reconciled with the Plan 058 owners below. Typed command/replay operations live
in `packages/sdk`; reusable queue/composer/request/review presentation lives in
`packages/client-ui`. Web supplies browser preferences, provider controls, error
actions and authenticated transport bindings. Retired Web renderers, history routes
and the old SDK package are not restored.

Postgres admission/inbox and the runtime lifecycle append remain the sole durable
queue, delivery and terminal owners. Both distinct `0033` migrations are retained
under their existing ledger IDs. Hosted session metadata includes latest-run and
approval-wait projections alongside session read receipts.

Web keeps the dev durable-creation barrier: a new session is published to submit
callers only after its SDK-backed create succeeds. The earlier main optimistic
creation draft tests are superseded by the existing deferred-create and failed-create
guards; established conversation drafts and retry bindings remain intact.

Remaining Web command/subscription bindings, including input command acknowledgement
and queue refresh, retire in Plan 058.3C/D when all real consumers use the canonical
SDK/App Server operations. Browser settings remain presentation preferences.

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

### Fixed-inventory legacy transcript recovery

| Responsibility | Canonical owner | Active consumers and boundary |
| --- | --- | --- |
| Operator import of the approved fixed legacy inventory and its immutable provenance | Existing `PostgresTranscriptRepository` import method plus one `legacy_history_import_receipts` table | One operator-only dry-run-by-default command resolves GitHub subject `46601256` against target `accounts/users`, imports transcript and receipt atomically, and retains raw source bytes. Durable Object exports keep the actual logical DO ID; local Wrangler SQLite uses `source_kind` plus the frozen source-instance locator and leaves `source_do_id` null. Normal session/message APIs cannot write provenance; Secure Durable Object/R2 records remain untouched. |

The receipt is provenance, not a transcript projection, ownership grant, or
runtime lifecycle record. Import coverage is limited to the exact frozen
environment/namespace/source-instance/key manifest. A local SQLite filename is
never presented as a logical Durable Object ID. Original records are idempotent
only when bytes, ownership, mapping, and manifest digest match; any mismatch
aborts for review. No public preview-key reader is retired by this import slice.

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
| Owned session/thread binding, idempotent prompt admission and execution claim | Existing PostgresTurnAdmissionRepository | HostedTurnScope reserves identity through the authenticated App Server; HandleChatRequest admits prompt/run atomically; RunEngineRequestHandler imports that identity and claims execution. |
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

## Plan 058 C1 — Hosted turn admission and scope

| Responsibility | Canonical owner | Active consumers |
| --- | --- | --- |
| Authenticated turn reservation and durable scope lookup | `HostedTurnScope` over the existing `PostgresTurnAdmissionRepository` and `startRunTurn` | Typed `turn/reserve` and `turn/scope` App Server operations; Web uses the SDK client and retains the actual admitted continuation pair. |

The public Brain `/turn/start` and `/turn/scope` routes and duplicated Web
response contract are retired. Runtime-internal routes remain available to the
existing runtime owner. The App Server principal supplies identity; callers only
send canonical run, session, client-message and optional revision identifiers.

## Plan 058 baseline — Session conversation and delivery binding

| Responsibility | Canonical owner | Active consumers |
| --- | --- | --- |
| Submitted transcript and terminal state | Existing Brain admission, transcript and lifecycle append owners | Web reads verified session history independently of execution scope and renders SDK lifecycle projections, including partial replies. |
| Browser authentication snapshot and session availability | Brain cookie-backed session endpoint; Web `GitHubService` and `AuthContext` | Only a validated session response can change auth state. A transient or invalid response preserves the last verified user; initial unknown state offers Retry before sign-in, and confirmed logout invalidates pending refresh writes. |
| Request acknowledgement and explicit delivery retry | Existing server admission identity and SDK `conversation-submission` over `submission-attempt-registry` / `submission-evidence`; Web `submissionTransport` binds the observed authenticated fetch | useChatCore supplies the synchronous reservation binding, captured provider configuration, request builder and dispatch callback; the SDK sequence retains one attempt, the exact reserved tuple, client message identity and serialized payload. Only bound acknowledgements or exact canonical evidence confirm admission. |
| Mounted conversation and history recovery presentation | Web SessionConversationSurface and useChatHydration | Setup/workspace share one useChat owner for the selected session; partial/failed reads preserve verified rows, and stale reads cannot replace another session. |

The run-filtered message identity/visibility helpers and the component-local
initial prompt guard are deleted. Session metadata without an active execution
keeps a null run identity. Background authentication refresh retains the mounted
conversation. Existing meaningful transport outcome safeguards are retained,
including suites removed by the incoming baseline's unrelated test cleanup.
Browser product caches are preserved; no storage cutover or import is performed.
SDK owns the reusable attempt registry and canonical evidence probe; Web keeps
the React orchestration and authenticated observed-fetch binding. History
transport moves through authenticated App Server in 058.3A. Shared conversation
composition remains pending 058.2E. The earlier baseline entries' pending
browser binding is fulfilled here, without claiming completion of hosted
routing or final browser acceptance.

### Plan 058 conversation submission orchestration

`packages/sdk/src/platform/conversation-submission.ts` owns the existing
non-React submission sequence moved out of Web `useChatCore`: one attempt for
the exact session/intent/client-message/generation, provider capture before
reservation, reservation reuse and retry identity, synchronous reservation
binding, dispatch, acknowledgement/evidence classification and one registry
settlement. `onReserved(scope)` is synchronous and precedes dispatch; a stale
binding settles inactive without sending. Web retains React state, optimistic
rendering, composer readiness, provider/repository selection, the request
builder and current dispatch callback, the observed authenticated fetch, the
scope-ready event and Stop/loading/error bindings. No route, transport, runtime
owner or Desktop capability changes.

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

## Plan 058.3A — Saved immutable artifact review reads

| Responsibility | Canonical owner | Active consumers |
| --- | --- | --- |
| Saved review source lookup and immutable patch integrity | Brain `EditArtifactReviewService`, composed through authenticated App Server and public SDK | Web `useEditArtifactReviewSource`, `useEditArtifactDiff`, and `useChangedFilesController` use `artifact/reviewLatest`, `artifact/reviewByMessage`, and `artifact/diff`. |

The review service remains the sole repository, R2, identity, SHA and patch-parser
owner. The SDK carries lookup source plus its inner 200/204 status; the hosted
binding uses the verified principal and preserves existing error classifications.
The Web direct client, three URL builders, and four legacy routes (including the
uncalled files route) are removed after a whole-repository caller audit. No live
Git fallback or fourth files operation is added; lookup misses remain bodyless
204 at the old HTTP boundary and successful review bytes stay immutable.

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

### Plan 058 hosted session metadata boundary

The existing session creation helpers are extracted unchanged to hosted
integration. Validated UUID session metadata operations bind a verified cookie
principal before App Server dispatch and reuse TranscriptRepository and
ThreadTitleService. Optional workspace references are checked against the user's
existing active workspace records. Local Thread semantics remain separate.
Web metadata cutover follows; read-receipt producer/store wiring needs its scoped
ownership decision before that missing baseline path can be completed.

### Plan 058 hosted session read receipts

The existing `thread_read_receipts` table remains the sole receipt store. Its
schema adds nullable `session_id UUID REFERENCES sessions(id) ON DELETE CASCADE`,
makes `thread_id` nullable, drops the `(thread_id, viewer_id)` primary key,
retains the thread foreign key and all existing rows, and adds unique
`(thread_id, viewer_id)` and `(session_id, viewer_id)` constraints plus a check
requiring exactly one owner binding. Existing thread receipt upserts retain
their conflict target; no rows are fabricated or backfilled.

A narrow session receipt repository over that table owns only per-viewer
acknowledgement and the derived hosted read state. It derives the latest
terminal turn from admitted canonical turn admissions joined to committed
terminal lifecycle events with matching thread, turn, and run-attempt identity;
runtime lifecycle append remains the only terminal producer. AppServer composes
the repository with the cookie-verified viewer, and SDK/Web consume its typed
`session/readReceipt` operation and session list/archived read-state fields.
TranscriptRepository and lifecycle persistence retain their existing owners.

### Plan 058 Web session metadata cutover

Navigation, title refresh and archived-session callers use existing SDK
AppServerClient operations through a Web-only presentation adapter. The mixed
SessionStateService no longer owns their HTTP methods, and old Brain metadata
routes/controller and Web URL builders are removed with all consumers wired.
The canonical owners remain TranscriptRepository and ThreadTitleService.
Browser cache/selection/draft storage is preserved pending actual profile
inventory. The hosted read-receipt operation and derived active/archived session
read-state fields are wired through AppServer and SDK. Authenticated Web
read/unread proof passed on 2026-10-13 for session
`17864ab0-2934-4c7d-a4ee-bff276c10554`: its completed turn appeared unread,
selecting the session cleared the marker, and a full reload preserved its
canonical history and read state.

The legacy `legioncode:sessions:v3` snapshot is frozen as read-only recovery
data: `SessionStateService` may continue reading it during this partial cutover,
but no Web path writes, clears, or reserializes it. Its records cannot validate
the per-tab `legioncode:active-session-id:v4` reference or provide active run or
workspace identity. The saved selector remains pending until the owned hosted
session list succeeds, then existing reconciliation keeps it only when that
server snapshot contains the session. A failed list leaves the selector
inactive and the sidebar reports the existing load error. The repository-folder
key remains a UI preference; removing a folder only changes the current view
and never clears in-memory conversation messages. Legacy per-session GitHub
context remains read-only for branch preference reconstruction. Full browser
storage retirement and any cache recovery/import policy remain undecided.

### Plan 058 authenticated hosted workspace selection

Hosted workspace list/select use the existing WorkspaceSelectionService and
WorkspaceRepository, composed with the cookie-verified principal. Selection
still resolves repository access through the authenticated GitHub client before
writing. Typed hosted record results remain distinct from local filesystem
grants. SDK/Web cutover follows in this slice; browser context reconciliation
and storage retirement remain pending their server-reconstruction proof.

### Authenticated session workspace context

The authenticated App Server session metadata operation resolves the owned
active or archived session, its optional owned run, and the exact owned
workspace. A unique exact-repository legacy match is display-only and keeps a
null workspace identity. Web uses this projection for session display and chat
request context; run branch remains the immutable historical run value. Explicit
workspace branch selection remains a server workspace/select command. The
session-scoped branch preference is a browser UI intent bound to the projected
canonical repository name; the existing legacy session context key is read only
for a matching repository and is never rewritten or deleted. An unbound match
never receives an inferred workspace ID; the canonical turn admission remains
responsible for authorizing execution. Workspace ownership and session/run
linkage are checked by the hosted metadata owner.

### Plan 058 Web workspace operation cutover

App selection/reconstruction and workspace bootstrap call the existing SDK
hosted workspace operations. GitHubService no longer owns workspace HTTP,
wire-record interfaces or response parsers; both replaced Brain HTTP routes
and WorkspaceController are deleted. Workspace hooks routes remain separate.
Current browser context reconciliation is explicitly not retired by this
transport cutover; its deletion requires authenticated server reconstruction
and existing-profile data preservation in the later authority slice.

## Plan 058.3B — Hosted provider discovery

| Responsibility | Canonical owner | Active producers and consumers |
| --- | --- | --- |
| Provider catalog, discovered models/cache refresh and product policy | Existing RunEngine provider services and Brain product policy | HostedProviderDiscovery composes the existing runtime proxy with verified cookie identity and authorized workspace claims. |
| Typed discovery transport | Existing AppServer provider/catalog and provider/models; provider/models/refresh | Existing SDK ProviderClient and Web ProviderApiClient use the hosted transport. Catalog adds optional canonical runId for hosted composition; models also accepts the existing BYOK query. Local operations retain their existing contracts. Refresh uses canonical runId/provider slug and the existing BYOK refresh result. |

Results reuse ProviderRegistryEntry, BYOKDiscoveredProviderModelsResponse and
BYOKDiscoveredProviderModelsRefreshResponse. Provider failures retain the existing
NormalizedProviderError fields plus HTTP statusCode at the AppServer envelope.
No credentials are included in discovery results. Server validates the cookie
principal and canonical run, then binds the workspace to that user's persisted
run/session; an unbound run or setup request uses the user's persisted active
workspace selection. Explicit workspace headers must match this server-derived
scope, and the workspace must remain owned and active. Generic execution scope
authorization is unchanged.
Web switches to AppServer; the replaced controller operation bodies are deleted.
All provider discovery, credential, preference, and resolution consumers use
the canonical App Server methods. Brain no longer registers standalone
`/api/byok/*` routes; authenticated App Server composition remains the hosted
boundary for these operations.


## Plan 058 hosted credential operations

Credential list/connect/label-update/disconnect/validate retain the existing
runtime provider credential owner, product policy and workspace preferences.
`ProviderCredentialOperations` contains the extracted operations; Brain's hosted
App Server composition authenticates the viewer and validates the canonical run
and workspace scope. Existing BYOK credential/request/validation schemas define
the wire contract. Secrets pass only to the runtime connect operation; returned
credential metadata retains the existing masked placeholder and fingerprints.
Web's ProviderApiClient/ProviderStore and provider dialogs consume the SDK
ProviderClient through the hosted App Server transport. Existing virtual
credential identifiers and default-on-connect behavior remain unchanged.
The retired standalone SDK transport has no remaining route consumers. Focused
credential isolation, policy, error, cancellation and transport tests guard the
hosted methods. No second vault or browser credential persistence is added.

Credential mutations consume and validate the existing runtime response before
returning success. Connect, default-on-connect, label writes, disconnect and
label cleanup propagate normalized failures; a failed runtime mutation cannot
be reported as a successful credential change. Existing runtime persistence
remains authoritative if a later step fails after an earlier step committed.


## Plan 058 hosted provider preferences and resolution

Preference reads/updates and effective provider resolution reuse the existing
BYOKPreference/BYOKPreferencesUpdateRequest and BYOKResolution/BYOKResolveRequest
schemas. `ProviderPreferenceOperations` extracts the existing preference,
credential/default/model policy and metadata/quota lookup bodies. The existing
runtime workspace preferences and provider services remain authoritative;
HostedProviderPreferences binds the verified viewer/run/workspace through the
same hosted provider scope as discovery/credentials. SDK ProviderClient and
Web ProviderApiClient/ProviderStore consume those validated hosted operations.
SDK `providers/selection` owns pure provider, credential, and model selection
derivation; ProviderStore supplies current catalog and session-selection state.
All exported SDK provider transports now use the authenticated App Server.
`createProviderAppServerTransport` is the canonical hosted transport, and
`createByokCloudTransport` delegates to it while preserving omitted cookie
credentials and explicit Authorization precedence. Web's ProviderApiClient and
SDK ProviderClient use the hosted operations for discovery, credential,
preference, and resolution requests. The standalone SDK `/api/byok` transport
and its public root/subpath exports are retired; callers migrate from
`baseUrl: "<brain-origin>/api/byok"` to `appServerBaseUrl: "<brain-origin>"`.

Brain's legacy provider route adapters and `ProviderController` are deleted.
The App Server provider integration suite retains the meaningful authentication,
scope, policy, error, default-model, credential, and visibility safeguards;
route-only response behavior no longer has an active consumer. The provider
scope/error/default/visibility tests in this path remain the acceptance gate.
Browser selection/readiness repair remains a separate pending authority slice;
this extraction introduces no local vault, selection store or new policy.

The existing uncapped visibility-list request is preserved only for authenticated
`provider/preferences/update`: SDK supplies an exact method routing hint, Brain
verifies the cookie before reading that body and rejects a mismatched envelope.
Other methods retain the generic 32 KB request limit and streaming cancellation.
The hint supplies no identity or permission and does not bypass provider scope.
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
| Pre-kernel startup failure and orphan Stop settlement   | RuntimeLifecycleCoordinator through the Brain runtime adapter | A captured startup claim may settle only its admitted matching tuple with zero lifecycle history. An orphan Stop requires no locally owned startup, interrupt handler, or approval resolver, and no queued or active execution in the existing per-run `RunExecutionLock`; it checks occupancy and queues synchronously, then revalidates ownership and history inside that lock. It accepts zero history on a matching running or recovery-required admission, or complete kernel-validated history proving a single pending approval/tool gate. One atomic canonical append settles admission and projections; tools are never replayed and execution claims are never reset. |
| Approval denial continuation                             | Runtime kernel approval and tool coordinators    | A durable denial is delivered to the matching active tool call once. Worker/provider refusal, cancellation, timeout, or a missing owner never substitutes for the user's decision; terminal settlement remains a canonical runtime event. |
| Recovery status and user-facing error presentation      | Authenticated turn-scope reader and thin Web adapter | Recovery does not hide the admitted identity. The client keeps typed delivery/runtime errors actionable and reconciles setup from durable admission and lifecycle state instead of owning session-failed status. |
| Assistant transcript and terminal status                | Canonical lifecycle append transaction           | Runtime events, assistant transcript parts, and session/run terminal status commit together. History and context assembly consume durable rows. The append path does not rebuild the unused full-turn projection cache. |
| Delivery confirmation and explicit retry                | Web `useChatCore` and its observed-fetch adapter | The SDK parses transport output. Exact HTTP tuple acknowledgement or canonical lifecycle evidence confirms admission. Unconfirmed retries retain the original client identity and serialized payload.                   |
| Hosted replay, diff, approval and compaction routing    | Authenticated Brain App Server composition       | `AppServerController` verifies the cookie principal before dispatch. `HostedLifecycleOperations` checks actual run ownership (reserved matching admission is accepted only for replay), then calls the existing `fetchRunRuntimeRoute` and RunEngineDO operations. SDK keeps the existing operation contracts and bindings; the four public lifecycle routes and their direct SDK URL builders are removed. Runtime owns the underlying replay, diff, approval and compaction behavior. |
| Hosted Stop/interrupt authorization and routing           | Brain `HostedTurnCommands` composed by the authenticated App Server | `AppServerController` binds the cookie principal; the command requires the principal-owned run and matching session/workspace before calling the existing RunEngineDO `/interrupt` route. SDK sends `turn/interrupt`; Web Stop still waits for the exact tuple's canonical terminal event. Runtime remains the interrupt and terminal lifecycle owner. The old `/api/run/interrupt` route and SDK URL builder are retired. |
| Hosted inbox, steering and resume commands              | Brain `HostedThreadInputOperations` composed by the authenticated App Server | The verified cookie principal supplies the user ID; each operation resolves the principal-owned session by canonical thread and matching workspace, then reuses the existing repositories, `ThreadInputCommandService`, image policy/storage and runtime route. The internal outcome preserves each legacy 200/201/202/409 status without adding a public receipt field. The SDK maps all eight existing commands through App Server and retains validated conflict receipts and error classifications. `ExecutionContext` remains bound to the real request for enqueue auto-start, queued start and resume. The eight legacy routes and direct SDK URL builders are retired. |
| Web lifecycle client host binding                       | SDK `PlatformClient`                             | Web creates the SDK client with its existing Brain base URL and HTTP transport. Replay, follow, approval, interrupt, compaction, and all eight inbox/steering/resume commands call the SDK directly; Web keeps only host URL/auth binding and product orchestration. `getTurnDiff` remains an SDK operation; existing review callers consume canonical diff through the lifecycle projection. |
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

## Verified pull-request links in saved chat

| Responsibility | Canonical owner | Active wiring and invariant |
| --- | --- | --- |
| Saved chat text and owned session scope | Existing TranscriptRepository and active transcript projection | Brain reads the complete pinned history for the authenticated session; superseded transcript branches are excluded and no history is imported or rewritten. |
| PR link discovery and remote state verification | Authenticated hosted App Server operation using the existing GitHub client | Only exact HTTPS `github.com/{owner}/{repo}/pull/{positive-safe-integer}` links from visible transcript text are candidates; each exact owner/repo/number is verified through GitHub. Per-link 403/404 candidates are omitted; account-wide auth, rate-limit and network failures stay explicitly unavailable, never empty/closed. |
| PR status scheduling and presentation | Web App visible-row binding plus active-session priority; shared UI renders supplied state | Web queries visible rows and the active chat with at most two concurrent requests, scopes bounded ephemeral cache to authenticated account/session/transcript update identity, cancels stale requests and prioritizes the active chat when its summary opens. Sidebar and summary consume the same verified response; PR indicators, unread dots and failure icons are independent. No association table, history backfill, arbitrary-URL fetch or shared-UI network authority is added. |

PR display state is derived and volatile: GitHub can change without a transcript
update, so hover/focus refreshes stale verification. An unavailable result is
never rendered as a successfully verified closed pull request.

## Web saved-chat details and sources

| Responsibility | Canonical owner | Active wiring and invariant |
| --- | --- | --- |
| Chat title mutation | Authenticated session metadata operation and ThreadTitleService | Sidebar and header rename capture the selected session ID, await the server response, and update only that session's canonical title projection. Errors stay visible to the user; run, workspace and status fields are not copied from a stale response. |
| Saved image source list | Authenticated transcript image references and ChatMediaStore | Web derives references only from restored user messages in the active `SessionConversationSurface`, validates the shared image-reference schema, deduplicates by attachment ID and resolves the existing authenticated image source. Draft and optimistic images are excluded; loading, partial and failed history remain explicit. Presentation reuses `ChatImageGallery`. |
| Outputs, subagents and background processes | Their separately scoped capabilities | Summary sections remain hidden until their canonical capabilities exist; Web does not infer runtime state or fabricate counts. |
