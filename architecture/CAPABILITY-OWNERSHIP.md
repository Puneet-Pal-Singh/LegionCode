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
markdown and action tests move with their source. Shared presentation has no
Web imports or product HTTP/storage authority. Browser clipboard remains UI
behavior; authentication, runtime commands and metadata derivation are unchanged.
