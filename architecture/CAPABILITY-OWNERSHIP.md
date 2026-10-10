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
| Message presentation metadata type | `client-ui/src/conversation/chat-message/types.ts` | Shared actions and Web metadata builders/ChatInterfaceView/ChatMessage. Metadata derivation remains Web-owned until its composition slice. |
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
