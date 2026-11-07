# 048 — Paired Local Host And Multi-Harness Adoption Plan

Status: Planned; no implementation started by this revision. Codex, Claude
Agent and OpenCode v2 are independent integration tracks, with no completion
dependency on Plan 057, Plan 058, the Native golden loop or another driver.
Connected-local pairing and cloud relay retain Plan 047 Gate C and their
authorization/continuation conformance gates.

Created: 2026-07-18

Uses current SDK/App Server/runtime contracts. Integration slices own any
missing in-path wiring and proof through canonical owners. Plans 025, 033,
041, 044, 046 and 047 supply architecture/connected-local constraints, not a
serial dependency on completing Desktop or Web extraction.

Updated: 2026-11-06 (Asia/Kolkata): independent local/cloud harness delivery,
including OpenCode v2 in the initial scope alongside Codex and Claude.

GitHub execution tracking (2026-10-19):
[#526 — External agent hosting with OpenCode v2 over ACP](https://github.com/Puneet-Pal-Singh/LegionCode/issues/526).
The previous execution order targeted dev after
[#485 — Plan 058 Web migration](https://github.com/Puneet-Pal-Singh/LegionCode/issues/485)
and [#486 — Plan 057 local workflow](https://github.com/Puneet-Pal-Singh/LegionCode/issues/486).
That blanket 058 → 057 → 048 order is superseded. Each integration delivers
and proves its required capabilities without waiting for those plans or another
harness to complete.
Independent native Zen/Go provider fixes remain tracked in #525. Remote issue
text has not been updated by this local planning revision.

Execution design:
[LLD 048 — Local Harness Integration And ChatGPT Plan Usage](LLD/048-local-harness-integration-and-chatgpt-plan-usage.md).
This is the authoritative implementation order for local adapters and sign-in.
Plan 057's existing LLD remains the sole authority for completing Plan 057.
File/package placement is fixed by
[Harness integration construction](../../../architecture/HARNESS-INTEGRATION.md),
based on pinned T3 Code, Codex OSS and OpenCode v2 source inspection. Start
drivers in harness-codex/harness-claude/harness-opencode and host machinery in
harness-core;
do not build app-local adapters that require later extraction.
The [ACP versus native decision](../../../architecture/HARNESS-TRANSPORT-DECISION.md)
compares all three current integrations. Use native Codex app-server, the
official Claude Agent SDK and native OpenCode v2 in cloud and local hosts.
Web/cloud and Mac/cloud share the same hosted Thread; Mac/local composes the
same driver packages through its local App Server. Generic ACP is a separate
extension path; no active-session transport fallback or client/runtime rewrite.
Managed-cloud integration for all three harnesses is owned by
[Plan 061](061-CLOUD-HARNESS-INTEGRATION-PLAN.md), consuming
048's shared delegated-harness contract. Cloud does not wait for a Mac
installer, local pairing, or full Desktop closure.
OpenCode implementation targets v2 only, with an explicit supported-version
check and no v1 fallback. Historical unversioned references below do not expand
that target.

Separate inference track: Plan 027 owns OpenCode Zen/Console API keys and
Go subscription-backed API keys used by LegionCode Native. Those provider
routes do not require OpenCode installation, ACP, or this plan's local harness
gate. They may ship in the cloud native runtime once provider acceptance passes,
with Desktop consuming the same route as its runtime becomes ready. Users may
instead select the OpenCode v2 harness through its native API, using its own
provider configuration. Both are required choices, not substitutes or fallbacks.

## 1. Decision

LegionCode attaches Codex, Claude Agent and OpenCode v2 independently through
the existing accountless local App Server, then adds a **paired local host**
as a separately gated connected execution placement.
Both use one product architecture. The host runs near a user workspace and can
attach to external coding harnesses such as Codex app-server, Claude Code, and
OpenCode. It owns local filesystem, Git, terminal, sandbox, and harness process
state. It reports normalized facts through the LegionCode session-host protocol.

Desktop is the full SDK client. It can control cloud environments and one or
more paired local environments in the same product session list. Web and
mobile clients receive the same authorized Thread snapshot and live
continuation, including for a paired-local workspace; they can review or send
only the commands that the host capability and runtime policy allow. No client
becomes a workspace runtime merely by opening that chat.

The first connected-local remote connection uses a cloud relay with an outbound,
authenticated WebSocket from the host. This works through NAT and avoids
opening a LAN port. SSH launch, direct LAN, Tailscale, or user-managed HTTPS
endpoints are optional later transport providers, not required product truth.

## 2. Upstream Lessons

### Codex OSS: stable runtime contract before many clients

Codex app-server exposes a bidirectional JSON-RPC control plane with
initialization/capability negotiation, Thread/Turn/Item primitives, streamed
notifications, explicit approval and user-input requests, turn interruption,
diff updates, generated schemas, bounded queues, and overload handling.

Adopt:

- initialization, protocol version, capability, and client identity handshake;
- typed request/response/notification/server-request separation;
- terminal event as the source of interrupt completion;
- generated or mechanically verified schemas;
- cursor-based continuation, bounded queueing, and explicit overload results.

Do not adopt:

- Codex private backend/auth coupling;
- Codex's internal state as LegionCode lifecycle truth;
- a Rust rewrite;
- every experimental app-server method.

Reference: <https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md>

### OpenCode: request shape and local performance discipline

Adopt:

- deterministic context/request layout and provider-neutral cache semantics;
- explicit prompt admission versus model execution;
- bounded concurrent safe tools with serialized durable settlement;
- workspace-scoped LSP, formatter, watcher, terminal, and MCP services with
  disposal and generation fencing;
- bounded read/grep/log projections with full evidence in artifacts.

Do not make an external harness's internal provider conversation appear
LegionCode-managed. Use Plan 044 `harness_reported` context telemetry when the
harness owns it.

### T3 Code: a host owns work; clients pair to it

T3 runs a local Node server that wraps coding-agent runtimes, converts their
events into ordered pushes, and serves Web/Desktop clients. Its remote model
keeps projects, files, Git, terminals, and provider sessions on the remote
machine. It supports pairing, direct LAN/Tailnet endpoints, and desktop-managed
SSH launch.

Adopt:

- one ordered host publication path;
- typed browser transport boundary;
- host readiness before client welcome;
- pairing credentials and revocable sessions;
- host placement independent of the client form factor;
- review/branch/PR workflows as first-class outputs.

Do not adopt:

- browser local storage as cross-device execution authority;
- an unauthenticated local listener;
- direct browser access to a public local host as the default deployment;
- a separate event model for each harness.

References:

- <https://github.com/pingdotgg/t3code/blob/main/docs/architecture/overview.md>
- <https://github.com/pingdotgg/t3code/blob/main/REMOTE.md>

### VS Code Agent Host: session survives its window

Adopt the Agent Host principle from Plan 046: a host outlives a client;
snapshots plus ordered channel updates reconnect clients; review, terminal, and
changes are resources; commands are validated by the host. Do not make client
reducers or raw client actions a lifecycle authority.

## 3. Target Topology

```text
             LegionCode cloud control plane
              /              |             \
             /               |              \
 canonical session host  environment registry  relay/auth service
          |                                      ^
          v                                      |
 Cloudflare runtime                       outbound mTLS/WSS
                                                 |
                                         paired local host
                                           /      |       \
                                      workspace  Git    harness adapters
                                                               |
                                       Codex app-server / Claude / OpenCode
```

The cloud control plane persists only LegionCode canonical records and
authorized environment metadata. It does not mount a local workspace or take
ownership of an external harness's hidden provider transcript.

## 4. Environment And Host Model

```ts
interface ExecutionEnvironment {
  readonly id: EnvironmentId;
  readonly kind: "cloud" | "paired_local";
  readonly ownerUserId: UserId;
  readonly hostStatus: "ready" | "offline" | "degraded" | "revoked";
  readonly capabilities: EnvironmentCapabilities;
  readonly protocolVersion: string;
  readonly publicKeyId: string;
}

interface HarnessAdapter {
  readonly id: HarnessAdapterId;
  readonly capabilities: HarnessCapabilities;
  initialize(input: HarnessInitializeInput): Promise<HarnessSession>;
  startTurn(input: HarnessStartTurn): Promise<HarnessCommandReceipt>;
  interruptTurn(input: HarnessInterruptTurn): Promise<void>;
  subscribe(input: HarnessSubscription): AsyncIterable<HarnessEvent>;
  decideApproval?(input: HarnessApprovalDecision): Promise<void>;
  readArtifact?(input: HarnessArtifactRequest): Promise<ArtifactPayloadRef>;
  dispose(input: HarnessDisposeInput): Promise<void>;
}
```

The adapter converts a harness event into a validated LegionCode command/result
or a normalized external-runtime fact. It cannot:

- append canonical lifecycle events directly;
- settle a parent LegionCode Turn without runtime validation;
- grant permissions;
- mint artifact, Git, or cloud credentials;
- infer a workspace scope from a client-supplied path.

The runtime/session host validates scope, authorization, idempotency, terminal
ordering, and artifact persistence before publishing canonical events.

## 5. Native Versus External Harness Semantics

| Concern | Native cloud/local LegionCode runtime | External harness adapter |
| --- | --- | --- |
| Tool policy | LegionCode owns it | Harness owns internal tool policy; adapter reports capability/facts. |
| Provider context | Plan 044 fully manages it | `harness_reported` telemetry only unless adapter is a Legion driver. |
| Approval | Canonical LegionCode approval | Map only supported harness approval requests; never fabricate equivalence. |
| Git/diff | Canonical turn artifacts | Import/derive an artifact with source provenance; never use live Git as final truth. |
| Interruption | Runtime command and terminal settlement | Forward request, then wait for validated terminal harness result. |
| Recovery | LegionCode event replay | Host/harness reconnect plus explicit degraded/offline state; never transcript repair. |

An external harness is not automatically interchangeable with the native
runtime. The user-facing environment picker must show exact supported
capabilities, including unavailable context metering, compaction control,
approval scopes, background terminals, and artifact detail.

## 6. Pairing And Security Protocol

### 6.1 Enrollment

1. User authenticates in a LegionCode client and requests a one-time host
   pairing challenge for a selected account/workspace policy.
2. Local host displays or consumes the challenge and generates a device key.
3. Cloud verifies the one-time challenge, records host public-key identity and
   allowed environment scope, then returns a short-lived relay credential.
4. Host creates an outbound authenticated connection and reports a signed
   capability manifest.
5. Client receives an environment projection; it never receives the host's
   long-lived credential or raw workspace path inventory.

### 6.2 Operation

- Every command carries environment, workspace, Thread, Turn, Run Attempt,
  actor, correlation, and idempotency identity.
- Relay sessions are short lived and rotate. Host key revocation immediately
  prevents reconnection and new commands.
- Local filesystem roots are resolved and enforced by the host. Cloud never
  accepts a client path as authorization.
- Host reports heartbeat/readiness and explicit disconnect reason. Offline is
  an environment state, not a failed Turn until the runtime settles it.
- A host may accept direct Tailnet/LAN/SSH transport later, but all transports
  terminate in the same authenticated host/session contract.

### 6.3 Tailscale and SSH

Tailscale and SSH are transport conveniences:

- **Relay first:** browser and desktop work without network exposure.
- **Tailnet direct later:** useful private-network latency option, with host
  pairing/session authorization still required.
- **Desktop SSH launch later:** desktop may start/reuse a local host over SSH
  and forward a loopback connection. The remote machine still owns workspace
  files, Git, terminal, and harness state.

Neither method changes canonical lifecycle ownership or gives a browser broad
filesystem access.

## 7. Delivery Program

### Local harness program — independent integration tracks

Reuse the existing local host. Do not require completion of Plan 057, Plan 058
or native inference, and do not require a LegionCode cloud account. The LLD
defines independent tracks; the list is not a serial order:

1. 048.L1: Codex app-server vertical slice using the selected local login.
2. 048.L4: independent Claude Agent SDK slice and subscription connection, subject
   to the Anthropic release gate in LLD 048. API-key proof alone does not
   complete the subscription milestone.
3. 048.L2: in-app Sign in with ChatGPT and authorized ChatGPT plan usage.
4. 048.L3: independent OpenCode v2 native server/client slice in initial scope,
   matching T3's integration instead of the earlier ACP proposal.
   It does not wait for Codex or Claude. Retain the existing slice identifiers.
5. 048.L5: Cursor through its supported SDK, after capability/auth validation.
6. 048.L6: later generic ACP registry/custom-agent support with its own
   protocol/conformance scope, independent of native OpenCode.

Every adapter proves prompt, approval, edit, cancellation, immutable review,
and restart/replay through the same SDK and runtime. Implement only the
selected transport per harness; additional native transports need a measured
capability gap. Do not expose LegionCode's own ACP server as a prerequisite;
that outward-facing capability belongs to Plan 026.

### Connected Phase 0 — prove canonical session-host conformance

Prerequisites: local harness gates above and Plan 047 Gate C.

Use the cloud host and two SDK clients to prove handshake, snapshots, cursor
resume, command idempotency, approval recovery, artifact read authorization,
and terminal settlement before implementing connected-local relay or pairing.

### Connected Phase 1 — paired-host protocol and fake adapter

1. Define environment enrollment, host heartbeat, revocation, capability, and
   command relay schemas.
2. Implement a fake local host plus fake harness adapter for contract tests.
3. Add host-process lifecycle, reconnect fencing, and capability unavailable
   outcomes.
4. Keep the protocol within the existing session-host/client SDK boundaries;
   create a package only when two real implementations share it.

Exit proof: a revoked or stale host cannot execute a delayed command or publish
an event for a new host generation.

### Connected Phase 2 — connect the existing local host

1. Reuse Plan 057's local workspace/runtime and the 048.L harness registry.
2. Add authorized synchronization and artifact transfer to the existing
   root-scoped filesystem, Git, shell, and permission capability reports.
3. Start with one operating system and fail closed on unsupported capabilities.
4. Use the cloud relay; do not ship Tailscale/SSH launch in this phase.

Exit proof: the same desktop client can start and review a cloud turn and a
local turn, while their environment, workspace, Git, approval, and artifact
identities remain distinct.

### Local adapter acceptance — Codex app-server

This acceptance belongs to 048.L1/L2; it does not wait for connected pairing.

1. Spawn/connect to `codex app-server` through a local-only adapter.
2. Implement initialize/version/capability negotiation and typed event mapping.
3. Map supported start/resume/interrupt/approval/input/diff functions with
   explicit unsupported results for the rest.
4. Persist imported review evidence as LegionCode artifacts with adapter and
   source-turn provenance.
5. Treat Codex provider context, compaction, and tool internals as
   harness-reported telemetry unless a separately approved driver mode exists.

Exit proof: a Codex turn can be started, observed, interrupted, reattached
after client reconnect, and reviewed from immutable artifact evidence without
making the Codex transcript a LegionCode lifecycle source of truth.

### Local adapter acceptance — independent harnesses

Codex, Claude Agent and OpenCode v2 each implement and pass the same generic
contract independently. Any first merged real consumer may seed it. A
driver-specific branch that blocks another driver belongs behind its adapter
or is removed; it is not an execution-order dependency.

### Connected Phase 3 — optional direct transports and remote UX

Add Tailnet direct, desktop-managed SSH launch, remote environment grouping,
and mobile pairing only after the relay model has security and reconnect proof.
Remote environments must not be created from arbitrary browser URLs or exposed
without pairing, expiry, revocation, and origin/network policy.

## 8. Required Conformance Gates

1. Cloud and local environments use identical SDK command/subscribe semantics.
2. A host disconnect does not duplicate a Turn, tool result, approval, or
   terminal settlement after reconnect.
3. Host generation fencing rejects stale delayed output and commands.
4. Environment/user/workspace authorization is checked for subscribe, command,
   artifact read, and pairing management.
5. An unavailable harness capability is explicit; no silent native/cloud
   fallback runs a different command.
6. External-harness events cannot mutate LegionCode lifecycle truth without
   runtime validation.
7. Diff/artifact evidence remains readable after the local host/harness exits.
8. Credentials, pairing secrets, host tokens, prompts, and raw tool output are
   redacted from lifecycle events and diagnostics.
9. A second harness adapter passes the generic suite without core runtime
   changes.

## 9. Explicit Non-Goals

- reimplement Codex, Claude Code, or OpenCode as LegionCode runtimes;
- publicly expose a local host listener by default;
- store a local workspace or harness credential in browser storage;
- make Tailscale, SSH, or a mobile app prerequisites for local execution;
- claim uniform context-meter/compaction behavior from black-box harnesses;
- permit adapters to bypass native Git, artifact, approval, or runtime policy;
- support write-capable multi-agent graphs before environment isolation and
  artifact review conformance are proven.

## 10. Completion Criteria

This plan is complete when a desktop client, using the same SDK as Web, can
reliably control both a LegionCode cloud environment and a securely paired
local environment; the local host can attach at least two proper harnesses
without core lifecycle changes; and every outcome remains replayable,
authorized, artifact-backed, and explicit about its capabilities.
