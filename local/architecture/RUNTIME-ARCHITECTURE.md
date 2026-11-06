# LegionCode Runtime Architecture

## Purpose

This document defines the target wiring for LegionCode. It is an architecture
contract, not a status report or implementation plan.

The governing invariant is:

> One kernel, one protocol, one lifecycle log, one workspace authority, one Git
> authority, and many thin clients and adapters.

When current code conflicts with this target, record the migration in
`CAPABILITY-OWNERSHIP.md`. Do not create a second permanent path.

## Canonical Topology

```txt
Web --------\
Desktop -----+--> @legioncode/sdk -----------------------> App Server
CLI ---------+                                              |
Mobile ------/                                      Runtime Protocol
                                                           |
                                                    Runtime Kernel
                                                           |
                                      +--------------------+--------------------+
                                      |                    |                    |
                                   Context             Lifecycle            Approval
                                    Engine                Store               Policy
                                      |                    |                    |
                                Model/Harness          Artifact/Git            Tool
                                   Adapter               Service             Registry
                                                                                |
                                                                         Execution Backend
                                                                          /      |      \
                                                                       Local   Cloud   BYO
```

The SDK and App Server are client-facing boundaries. App Server owns transport,
handshake, command/query routing, snapshots, and continuation, while delegating
product policy to canonical owners. The runtime kernel owns execution policy
and lifecycle truth. Adapters and execution backends are replaceable
implementations behind narrow ports.

The "one protocol" invariant means one canonical domain language in
`platform-protocol`. App Server's internal protocol modules provide versioned
wire envelopes and method contracts; they reference canonical
identities/events/artifacts and may not redefine a competing lifecycle schema.

## Canonical Ownership

| Responsibility                                                              | Canonical owner                                                 | Non-owners                                   |
| --------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------- |
| Thread, turn, run-attempt, tool, approval, artifact, and terminal lifecycle | Runtime kernel through the runtime protocol                     | Web, Desktop, Brain controllers, projections |
| Durable lifecycle history                                                   | Lifecycle store                                                 | Live stream, React state, localStorage       |
| Live delivery                                                               | Continuation of durably appended lifecycle events               | Independent in-memory event authority        |
| Transcript, workflow, sidebar status, usage UI, review UI                   | Pure SDK/client projections over canonical events and artifacts | Runtime and persistence mutation code        |
| Context assembly, budgeting, compaction, and usage accounting               | Context engine invoked by the runtime kernel                    | Persistence pruning and UI counters          |
| Tool availability and policy metadata                                       | Tool registry plus permission policy                            | Harness adapters and clients                 |
| Workspace state and execution                                               | Workspace authority through an execution backend                | Web and model-provider adapters              |
| Completed-turn diff and review                                              | Turn artifact/Git service                                       | Live working-tree guesses                    |
| Provider and model behavior                                                 | Provider/model adapter and catalog                              | Central UI or runtime switch statements      |
| External harness integration                                                | Harness adapter translating to canonical runtime events         | Harness-specific lifecycle or persistence    |
| Authentication and admission                                                | Control plane                                                   | Runtime tool and lifecycle policy            |

If two modules can independently decide the same row, the architecture is
transitional and the competing owner must have a deletion trigger.

## Dependency Direction

Allowed direction:

```txt
clients -> @legioncode/sdk -> app-server
sdk transport -> app-server internal protocol
app-server -> platform-protocol and canonical command/query ports
control plane -> hosted app-server auth/routing adapter
runtime adapters -> runtime-kernel -> platform-protocol
runtime-kernel -> context / event / permission / tool / workspace / git ports
persistence adapters -> event and projection repositories
harness adapters -> harness port -> runtime-kernel
execution backends -> worker protocol
```

Forbidden direction:

- Clients importing runtime, Brain, persistence, worker, or Git
  implementations.
- Runtime policy importing client components or app-local view models.
- Harness adapters writing lifecycle events, approvals, artifacts, or
  persistence outside the kernel append path.
- Execution backends deciding turn status or final assistant output.
- Projections mutating source-of-truth state.
- Context code depending directly on one client or one provider transport.

Package export maps and import-boundary policy must enforce these directions
where they can be expressed mechanically.

## Command And Identity Model

Commands target the complete canonical identity needed for their operation.
Important identities are typed and are not reconstructed from local UI state.

Minimum runtime commands:

- Create or resume a thread.
- Start a turn.
- Decide an approval.
- Interrupt a specific active turn/run attempt.
- Read lifecycle events after a sequence.
- Read completed-turn artifacts and diff.

Interrupt is scoped to the active thread, turn, and run attempt. It emits one
terminal interrupted lifecycle event and settles every in-flight tool and
approval. Closing a browser stream is not interruption.

## Persist, Then Publish

Every canonical lifecycle item uses one append path:

```txt
validate
-> assign canonical identity and sequence
-> append durably
-> publish live continuation
-> update projections
```

Live and replay are two delivery modes for the same ordered records. A refresh
must converge to the same transcript, workflow, tool, approval, usage, artifact,
and terminal state that was visible live.

In-memory streams may transport events, but they are never the source of truth.
Cloud and local transports must obey the same replay and continuation contract.

## Lifecycle Items And Projections

The protocol must represent at least:

- Turn started, completed, failed, interrupted, cancelled, and timed out.
- Reasoning/thinking started, delta, and completed.
- Tool requested, started, progress, completed, failed, and interrupted.
- Approval requested, decided, expired, and interrupted.
- Context assembled and compacted.
- Token/model-context usage updated.
- Artifact and diff created.
- Final assistant output completed.

Clients build pure projections:

```txt
projectTranscript(events)
projectWorkflow(events)
projectTurnStatus(events)
projectTokenUsage(events)
projectReview(artifacts)
```

Projection functions may cache results but cannot invent or mutate runtime
state. The same projectors should be reusable by Web, Desktop, CLI, and SDK
consumers.

## Context And Token Architecture

Context is assembled inside the runtime before each model step:

```txt
system and workspace instructions
-> relevant repository context
-> durable conversation history
-> active-turn tool results
-> model-specific budget policy
-> optional explicit compaction
-> provider request
```

The context engine owns:

- Provider-reported model context-window capacity.
- Reserved output and reasoning budget.
- Current input, cached-input, output, and reasoning usage.
- Total thread usage and last-turn usage.
- Selection and truncation policy.
- Explicit compaction summaries and compaction lifecycle events.
- Pruning of obsolete large tool output from future model requests.

Character-count estimates may be a conservative fallback for providers that do
not report tokens, but they must be labeled estimates and must not override
provider-reported usage.

Compaction produces a durable typed item. It must not silently rewrite the
visible transcript or hide missing context.

## Local And Cloud Execution

Desktop local execution and Web cloud execution implement one execution
backend contract:

```txt
open workspace
execute tool
stream progress
interrupt
read artifact
release workspace
```

The selected backend is part of the workspace/run-attempt configuration. It
does not change lifecycle semantics, tool schemas, approval behavior, SDK
behavior, or artifact format.

Desktop remains a thin client plus a local execution-backend host. It does not
fork the runtime kernel.

## Harness Adapters

Codex, Claude Code, OpenCode, ACP, and future harnesses implement one harness
adapter contract.

An adapter may:

- Translate LegionCode input into harness input.
- Translate harness reasoning, tool, approval, usage, and final events into
  canonical runtime inputs.
- Expose harness capabilities and supported interruption behavior.

An adapter may not:

- Create its own durable thread or turn authority.
- Write directly to client projections.
- Bypass tool registry or approval policy.
- Own workspace or Git truth.
- Persist a second transcript.

Harness-specific data belongs in typed extension metadata, not parallel
lifecycle schemas.

## Safe Replacement Procedure

Replace responsibilities, not filenames:

1. Name the valuable behavior and known behavior that must not be preserved.
2. Identify every active producer, consumer, fallback, state store, and owner.
3. Define the canonical contract and owner.
4. Characterize valuable existing behavior.
5. Wire the replacement into the real product path.
6. Migrate every producer and consumer.
7. Delete duplicate authorities, obsolete exports, flags, and fallbacks.
8. Update `CAPABILITY-OWNERSHIP.md`.
9. Verify live behavior, replay, interruption, terminal settlement, and
   artifacts where applicable.

A package is not integrated because it builds or has unit tests. Integration
means real product producers and consumers cross its public contract.

## Adding A Feature

A feature is an easy addition when it:

1. Adds or extends a protocol type only when new product information is needed.
2. Extends a narrow kernel port or supplies a new adapter implementation.
3. Emits canonical lifecycle items through the single append path.
4. Adds or updates pure SDK/client projections.
5. Does not modify unrelated clients or duplicate runtime policy.

Examples:

- A new workflow visualization changes a projector and client UI, not runtime
  ownership.
- A new model updates the provider catalog and adapter, not the composer.
- A local backend implements the execution contract, not a second runtime.
- An ACP harness implements the harness contract, not a second transcript.

## Completion Standard

Architecture work is incomplete when:

- A replacement exists but active consumers still use the old path.
- Live and replay use different authorities.
- A client or adapter decides canonical runtime state.
- Removed behavior has no wired replacement or explicit intentional-removal
  decision.
- A temporary duplicate path lacks an owner and deletion trigger.
- A package is described as integrated without real-path producers and
  consumers.

Tests and gates prove these decisions. They do not substitute for ownership,
contracts, correct wiring, consumer migration, and deletion of competing paths.
