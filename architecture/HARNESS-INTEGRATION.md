# Harness integration construction

Decision date: 2026-11-06, Asia/Kolkata.
Status: Target construction for Plans 048 and 061. These directories and
capabilities are not claimed as implemented. Implementation creates each module
with its first working consumer; this document does not request scaffolding.

## 1. Construction decision

Use T3 Code's driver/instance/session/host separation, Codex OSS's protocol and
connection ownership boundaries, and OpenCode v2's separation of schema,
protocol, client, server and execution services. Keep LegionCode's existing
SDK, App Server, lifecycle, admission, workspace, Git and persistence owners.

The companion [ACP versus native decision](HARNESS-TRANSPORT-DECISION.md)
compares current interfaces and bridges in depth. Its reviewed choice is native
Codex app-server, official Claude Agent SDK and native OpenCode v2 for Web
cloud and Mac cloud/local alike. ACP remains a valid independent extension
path behind the same host contract; it is not excluded by cloud placement.

Concrete Node integrations belong in `harness-codex`, `harness-claude` and
`harness-opencode` from their first implementation. OpenCode v2 uses its native
server and typed client, matching T3's integration. Host machinery belongs in
`harness-core`.
They are used unchanged by the local App Server process and cloud sandbox
supervisor. They do not first live inside Electron, Brain or execution-engine
and move into packages later. The native inference registry in `provider-core`
remains distinct from these complete external agent runtimes.

This replaces the earlier Plan 048/061 suggestion to put concrete adapters
inside execution-engine and extract them later. The present dependency already
justifies packages: the same Node process/SDK code must run locally and in a
Linux sandbox while staying out of Workers, browser and Electron renderer
bundles. No framework, database engine or application rewrite is required.

### Independent integration program

The product support matrix is:

| Client | Cloud execution | Local Mac execution |
| --- | --- | --- |
| Web | Codex, Claude Agent and OpenCode v2 | Outside initial scope; later explicit local-host pairing |
| Mac Desktop | The same hosted environments/threads as Web | The same three drivers through the local App Server |

Client kind and execution placement are independent. Desktop does not imply
local execution. Desktop cloud mode uses the hosted SDK/App Server and
cloud-owned credentials, processes, files and history; it does not launch a
local CLI or copy a local login. Desktop local mode uses the loopback App
Server and Mac-owned resources, without requiring a LegionCode account.
Both compositions load the same driver packages and expose the same canonical
contracts, with negotiated capabilities per driver/environment.

A cloud Thread has the same identity, ordered history, approvals and review
whether opened from Web or Mac, and continues when either client disconnects.
A local Thread stays local unless explicitly published/paired. Changing the
environment picker cannot move an active attempt or silently copy repository,
session or credential state. Cross-placement handoff remains separate later
scope. Local execution needs its host Mac awake.

Per-driver acceptance covers Web → cloud, Mac → cloud and Mac → local. Mac cloud
preserves Web's saved Thread and control bindings; Mac local proves account/
workspace isolation. Integration can ship independently, while claiming the
full client matrix requires the corresponding installed-Mac proof. No adapter
is duplicated by client or placement.

Codex, Claude Agent and OpenCode v2 are three first-class, independently
implementable and releasable tracks in both local and cloud placements. Plans
048/061 do not depend on completing Plan 057, Plan 058 or the LegionCode Native
golden loop. No driver waits for another driver to pass first. The first real
consumer seeds the shared contract; later merges consume that reviewed version.

Each integration owns any missing admission, permission, Stop, replay, lease
or artifact wiring needed for its path through the existing canonical services.
These are acceptance requirements to implement and prove within the integration,
not reasons to park it behind a numbered Desktop/Web milestone. Reuse current
reviewed SDK/App Server boundaries; coordinate conflicting edits with 057/058
without waiting for their remaining roadmap or duplicating their owners.

Integration acceptance exercises a real SDK → App Server → runtime → harness
→ persisted review path. Desktop packaging and full shared-UI migration have
their own acceptance under 057/058. Adapter engineering does not depend on those
deliverables, while an advertised Mac UI feature still needs installed-app proof.

### T3 alignment and product-specific boundaries

| Responsibility | T3 pattern retained |
| --- | --- |
| Codex integration | Native Codex app-server with typed protocol and reverse requests |
| Claude integration | Claude Agent SDK query/session/permission lifecycle |
| OpenCode v2 integration | Native supervised server, typed API and subscribed event stream |
| Account isolation | Configured instance and continuation identity separate from driver kind |
| Client boundary | UI reads capabilities; host owns processes, credentials and machine state |
| Integration acceptance | Real-provider transcript replay through adapters and product projections, plus live acceptance |

LegionCode retains its canonical admission/event/artifact owners and durable
history retention. Its managed-cloud bridge/lease supervision is additional
deployment work. Package names and implementation framework follow LegionCode's
existing boundaries. This is alignment with T3's integration approach, not a
claim that its source implementation or production reliability is inherited.

Before enabling a capability, prove representative real-provider transcripts
through the actual integration and existing replay checks: multiple turns,
immediate Stop, approvals/denial, questions, account isolation, session recovery,
reported limits and terminal cleanup. Include settings advertised after session
open, model defaults and late/background work when those capabilities are
offered. Existing fixture/assertion locations must respect AGENTS.md's rule
against adding test files or registrations. Passing a mock adapter is insufficient.

## 2. Source revisions and scope inspected

### ACP decision rationale

ACP is a valid, platform-independent integration option for cloud and local
hosts; deployment placement does not rule it out. Its
[architecture](https://agentclientprotocol.com/get-started/architecture) defines
a common agent/client protocol, and [OpenCode v2](https://opencode.ai/v2/docs/cli/acp/)
supports it directly. The [per-harness comparison](HARNESS-TRANSPORT-DECISION.md)
selects native for direct account, execution and recovery integration, while
acknowledging the bridge functionality and shared-client work ACP provides.
This matches T3's built-in choices; T3 also has a shared generic ACP adapter.
It is not evidence that ACP is inherently less reliable.

ACP can reduce protocol-specific client work. For a runtime exposed through an
ACP bridge, feature availability also depends on that bridge and its negotiated
extensions. Native integrations trade that bridge dependency for maintenance
of three upstream interfaces. Either choice still needs tenancy, credentials,
supervision, durable delivery and replay proof. Generic ACP remains later scope;
an explicit future transport decision stays behind the same driver contract
and does not change the Web/cloud/Desktop/local architecture.

Repository paths below refer to these fixed revisions, rather than mutable
default branches. Source inspection covered the named contracts and selected
execution/auth/recovery implementations; it is not a security audit of every
file in any repository.

| Repository | Inspected revision | Relevant baseline |
| --- | --- | --- |
| [T3 Code](https://github.com/pingdotgg/t3code/tree/10f88f34edca46ee529db09598476715f32d507b) | `10f88f34edca46ee529db09598476715f32d507b` | Package boundaries, native Codex/Claude drivers, event commit and effect recovery |
| [Codex OSS](https://github.com/openai/codex/tree/faeb379646bdbad016e11f7c9ca91113cad4bc9d) | `faeb379646bdbad016e11f7c9ca91113cad4bc9d` | Rust app-server protocol/transport/client separation, authentication owner fencing, admission and reply handles |
| [OpenCode v2](https://github.com/anomalyco/opencode/tree/d86331ce73c26c95f2e5fa283a18ac0840f656c5) | `d86331ce73c26c95f2e5fa283a18ac0840f656c5` | Actual `dev` source; core/server/protocol package manifests identify version `2.2.5`, not a v1 tree inferred from an adapter filename |
| LegionCode integration baseline | `ccaa54ca5240711c6d621ba39bc1465d74bc00b0` | Locally available `origin/dev`, dated 2026-11-06; main checkout is older and contains unrelated changes |

### T3 Code findings

- [Provider construction guide](https://github.com/pingdotgg/t3code/blob/10f88f34edca46ee529db09598476715f32d507b/docs/internals/adding-a-provider.md) directs integrations into packages with separate settings, client and server entries. Its Codex/Claude drivers have not yet completed that extraction. Follow its documented boundary immediately; do not reproduce the transitional app-local placement.
- [Driver](https://github.com/pingdotgg/t3code/blob/10f88f34edca46ee529db09598476715f32d507b/packages/provider-core/src/server/driver.ts), [adapter](https://github.com/pingdotgg/t3code/blob/10f88f34edca46ee529db09598476715f32d507b/packages/provider-core/src/server/ProviderAdapter.ts) and [host](https://github.com/pingdotgg/t3code/blob/10f88f34edca46ee529db09598476715f32d507b/packages/provider-core/src/server/ProviderHost.ts) distinguish a reusable implementation, a configured account instance, a live external session and host-owned paths/credentials. Adapters access the application through injected host services.
- [Codex driver](https://github.com/pingdotgg/t3code/blob/10f88f34edca46ee529db09598476715f32d507b/apps/server/src/provider/Drivers/CodexDriver.ts) and [Claude driver](https://github.com/pingdotgg/t3code/blob/10f88f34edca46ee529db09598476715f32d507b/apps/server/src/provider/Drivers/ClaudeDriver.ts) resolve per-instance configuration and continuation identity. Their large [Codex adapter](https://github.com/pingdotgg/t3code/blob/10f88f34edca46ee529db09598476715f32d507b/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts) and [Claude adapter](https://github.com/pingdotgg/t3code/blob/10f88f34edca46ee529db09598476715f32d507b/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts) mix many responsibilities: split transport, mapping, permissions, session and usage modules at construction.
- [EventSink](https://github.com/pingdotgg/t3code/blob/10f88f34edca46ee529db09598476715f32d507b/apps/server/src/orchestration-v2/EventSink.ts#L635) commits accepted intent, events, projections and side-effect records transactionally, then publishes. [EffectOutbox](https://github.com/pingdotgg/t3code/blob/10f88f34edca46ee529db09598476715f32d507b/apps/server/src/orchestration-v2/EffectOutbox.ts#L125) distinguishes replay-safe recovery from process-bound start/steer/interrupt/reply effects. Adapt this discipline to existing LegionCode admission and inbox records; do not install another orchestrator or outbox owner.
- [Session manager](https://github.com/pingdotgg/t3code/blob/10f88f34edca46ee529db09598476715f32d507b/apps/server/src/orchestration-v2/ProviderSessionManager.ts#L154) manages live process attachment separately from durable state. [Finalization](https://github.com/pingdotgg/t3code/blob/10f88f34edca46ee529db09598476715f32d507b/apps/server/src/orchestration-v2/RunFinalizationService.ts) captures review evidence after provider work ends. Preserve that distinction so review capture does not inflate model-running time.
- [Architecture](https://github.com/pingdotgg/t3code/blob/10f88f34edca46ee529db09598476715f32d507b/docs/internals/overview.md) describes pruning older events once projections cover them. LegionCode retains its canonical durable lifecycle contract; adopting T3's pruning would change that contract and is excluded.

OpenCode parity was additionally checked against T3's
[v2 server owner](https://github.com/pingdotgg/t3code/blob/10f88f34edca46ee529db09598476715f32d507b/packages/provider-opencode/src/server/v2/OpenCode2Server.ts),
[typed client](https://github.com/pingdotgg/t3code/blob/10f88f34edca46ee529db09598476715f32d507b/packages/provider-opencode/src/server/v2/OpenCode2Client.ts)
and [adapter](https://github.com/pingdotgg/t3code/blob/10f88f34edca46ee529db09598476715f32d507b/packages/provider-opencode/src/server/v2/adapter.ts).
They use the native API, authenticated server-info readiness and an SSE
subscription established before starting work. That path supersedes the earlier
ACP choice. T3 uses the Effect client; LegionCode can use upstream's pinned
[Promise client export](https://github.com/anomalyco/opencode/blob/d86331ce73c26c95f2e5fa283a18ac0840f656c5/packages/client/package.json)
without changing application frameworks.

### Codex OSS findings

- [Protocol export](https://github.com/openai/codex/blob/faeb379646bdbad016e11f7c9ca91113cad4bc9d/codex-rs/app-server-protocol/src/export.rs) produces TypeScript and JSON Schema. Generate and pin the wire types inside the Codex adapter; do not hand-maintain a second Codex protocol in LegionCode's public schemas.
- [Transport crate](https://github.com/openai/codex/blob/faeb379646bdbad016e11f7c9ca91113cad4bc9d/codex-rs/app-server-transport/src/lib.rs) separates framing/connection mechanics from handlers. This is a responsibility boundary, not a requirement to create one TypeScript package for every Rust crate.
- [Reply handle](https://github.com/openai/codex/blob/faeb379646bdbad016e11f7c9ca91113cad4bc9d/codex-rs/app-server-client/src/server_request.rs) captures the originating connection and a single-use request capability. Later UI selection cannot redirect an approval; stale replies do not reconnect or retry themselves.
- [Connection auth](https://github.com/openai/codex/blob/faeb379646bdbad016e11f7c9ca91113cad4bc9d/codex-rs/app-server-transport/src/connection_auth.rs), [RPC gate](https://github.com/openai/codex/blob/faeb379646bdbad016e11f7c9ca91113cad4bc9d/codex-rs/app-server/src/connection_rpc_gate.rs) and [runtime auth binding](https://github.com/openai/codex/blob/faeb379646bdbad016e11f7c9ca91113cad4bc9d/codex-rs/runtime-agent-instance/src/binding.rs) bind work to the selected credential source and invalidate stale owners. Adopt account/source generation fencing, not Codex's backend registration implementation.
- [Turn admission](https://github.com/openai/codex/blob/faeb379646bdbad016e11f7c9ca91113cad4bc9d/codex-rs/app-server/src/turn_admission.rs) separates accepting new work from draining existing work. [External auth](https://github.com/openai/codex/blob/faeb379646bdbad016e11f7c9ca91113cad4bc9d/codex-rs/app-server/src/external_auth.rs) owns bounded refresh requests and avoids exposing token-bearing parse errors. Use these patterns within LegionCode's own admission and credential owners.

### OpenCode v2 findings

- [Core](https://github.com/anomalyco/opencode/blob/d86331ce73c26c95f2e5fa283a18ac0840f656c5/packages/core/package.json), [protocol](https://github.com/anomalyco/opencode/blob/d86331ce73c26c95f2e5fa283a18ac0840f656c5/packages/protocol/package.json), [server](https://github.com/anomalyco/opencode/blob/d86331ce73c26c95f2e5fa283a18ac0840f656c5/packages/server/package.json) and the client source separate execution services, API definitions, handlers and client decoding. Its conditional SQLite/PTY/Claude-SDK imports show why Node and workerd dependencies need explicit boundaries.
- [Credential schema](https://github.com/anomalyco/opencode/blob/d86331ce73c26c95f2e5fa283a18ac0840f656c5/packages/schema/src/credential.ts) distinguishes key, OAuth and externally managed sources. [Credential service](https://github.com/anomalyco/opencode/blob/d86331ce73c26c95f2e5fa283a18ac0840f656c5/packages/core/src/credential.ts#L129) serializes renewal per credential across callers/processes. Adopt the type distinction and coordination; cloud renewal additionally needs durable CAS/generation fencing across hosts.
- [Bus](https://github.com/anomalyco/opencode/blob/d86331ce73c26c95f2e5fa283a18ac0840f656c5/packages/core/src/bus.ts) distinguishes live delivery from durable per-aggregate reads. [Event feed](https://github.com/anomalyco/opencode/blob/d86331ce73c26c95f2e5fa283a18ac0840f656c5/packages/server/src/event-feed.ts) fails an overflowing subscriber rather than silently losing its continuity. Preserve LegionCode replay and bound its delivery buffers.
- [Run coordinator](https://github.com/anomalyco/opencode/blob/d86331ce73c26c95f2e5fa283a18ac0840f656c5/packages/core/src/session/run-coordinator.ts) distinguishes interrupt acknowledgement from cleanup. [ACP turn handling](https://github.com/anomalyco/opencode/blob/d86331ce73c26c95f2e5fa283a18ac0840f656c5/packages/cli/src/acp/turn.ts#L261) drains observed completion after interruption. A transport acknowledgement cannot release LegionCode's checkout lease.
- [ChatGPT plugin](https://github.com/anomalyco/opencode/blob/d86331ce73c26c95f2e5fa283a18ac0840f656c5/packages/core/src/plugin/provider/chatgpt.ts) implements plan-backed model access; [Claude integration](https://github.com/anomalyco/opencode/blob/d86331ce73c26c95f2e5fa283a18ac0840f656c5/packages/core/src/plugin/provider/claude-agent/integration.ts) and [provider](https://github.com/anomalyco/opencode/blob/d86331ce73c26c95f2e5fa283a18ac0840f656c5/packages/core/src/plugin/provider/claude-agent/provider.ts) have a separate Agent SDK path. A subscription inference plugin is not proof that all OpenCode agents use Codex app-server. LegionCode's Codex integration remains the actual Codex harness.

## 3. Fixed package and directory map

Paths without an existing counterpart below are planned additions. Every file
has one owner and a first delivery slice; do not create the whole tree in a
foundation-only PR. Use existing TypeScript/Zod and dependency injection.

```text
packages/
  platform-protocol/src/harness/
    instance.ts                    # public instance/account/configuration references
    capabilities.ts                # truthful supported operations and policy modes
    usage.ts                       # redacted quota/turn accounting and freshness
    operations.ts                  # App Server harness setup/read commands
  worker-protocol/src/harness.ts    # private bridge commands and observation schemas

  runtime-kernel/src/harness/
    DelegatedHarnessPort.ts         # runtime's placement-independent execution port
    DelegatedTurnCoordinator.ts     # existing lifecycle/approval/artifact owners composed
    HarnessObservationIngestor.ts   # validates binding and appends canonical facts

  harness-core/
    src/client.ts                  # plain metadata contract; no Node, React or kernel
    src/server.ts                  # explicit Node-host export
    src/server/
      HarnessDriver.ts             # driver/instance/live-session interfaces
      HarnessHost.ts               # injected paths/process/credentials/clock services
      HarnessRegistry.ts           # configured instances; duplicate identity rejection
      HarnessSessionManager.ts     # live attachment; never canonical persistence
      HarnessExecutionPort.ts      # local in-process implementation of kernel port
      ProcessSupervisor.ts         # lifecycle, bounded stderr, group termination
      ObservationDeliveryJournal.ts # unacknowledged bridge frames, not product history
      InstanceEnvironment.ts       # explicit credentials/config and sanitized child env
      ScopedRequestReply.ts        # single-use request + originating session generation
      errors.ts

  harness-codex/
    src/settings.ts                # validated instance settings, no secret values
    src/client.ts                  # browser-safe label/icon/settings definition
    src/server.ts
    src/server/
      CodexDriver.ts               # instance composition, thin
      CodexSession.ts              # initialize, ensure/resume thread, start/stop
      CodexEventMapper.ts          # native events to typed observations
      CodexPermissionMapper.ts     # supported policy/request/decision translation
      CodexUsageReader.ts          # supported account telemetry and measured tokens
      CodexAuthentication.ts       # explicit CLI-managed vs app-managed auth modes
      protocol/
        generated/                 # pinned upstream TS/JSON schemas and metadata
        StdioRpcClient.ts          # framing, pending request table, deadlines, shutdown
        ServerRequestRouter.ts     # scoped reverse-RPC replies, no lifecycle decisions
    scripts/generate-protocol.mjs   # deterministic schema/type generation and drift check

  harness-claude/
    src/settings.ts
    src/client.ts
    src/server.ts
    src/server/
      ClaudeDriver.ts              # instance composition, thin
      ClaudeSession.ts             # SDK query/input lifecycle and explicit resume
      ClaudeEventMapper.ts
      ClaudePermissionMapper.ts
      ClaudeUsageReader.ts
      ClaudeAuthentication.ts
      sdk/ClaudeQueryRunner.ts     # only SDK/process plumbing; no canonical event store

  harness-opencode/
    src/settings.ts
    src/client.ts
    src/server.ts
    src/server/
      OpenCodeV2Driver.ts          # thin native-v2 instance composition
      OpenCodeInstallation.ts      # pinned 2.x binary probe; reject v1/unknown
      OpenCodeServerOwner.ts       # private native server, credentials and readiness
      OpenCodeClient.ts            # typed API and SSE subscription/liveness
      OpenCodeSession.ts           # create/attach, prompt, interrupt and reconciliation
      OpenCodeEventMapper.ts
      OpenCodePermissionMapper.ts
      OpenCodeAuthentication.ts    # supported host-local provider login/config
      OpenCodeUsageReader.ts       # reported prompt/session usage; quota may be unknown

  app-server/src/harness/
    HarnessOperations.ts           # typed setup/status dispatch, shared by placements
    LocalHarnessComposition.ts     # concrete Node drivers and local services
  sdk/src/harness/
    client.ts                      # typed operations through existing App Server client
    usage-projection.ts            # pure read model; no provider polling from UI
  client-ui/src/harness/
    HarnessConnectionSettings.tsx
    HarnessSelection.tsx
    HarnessUsage.tsx

  persistence/src/harness/
    types.ts                       # binding repository contract, no parallel lifecycle
    PostgresHarnessBindingStore.ts
  persistence/src/schema/harness.ts
  event-store/src/local/harness-bindings.ts  # same existing local SQLite database/writer

apps/
  brain/src/integration/app-server/HostedHarnessOperations.ts
  brain/src/services/harness/
    HarnessConnectionService.ts     # tenancy, explicit connection and account policy
    HarnessCredentialRefresh.ts     # encrypted-store renewal with durable generation CAS
  secure-agent-api/src/harness/
    CloudHarnessExecutionPort.ts   # Worker-safe kernel port through private bridge
    CloudHarnessSupervisor.ts      # sandbox bootstrap/readiness/lease checks
  secure-agent-api/harness-host/
    main.ts                        # Node sandbox entry; imports the same driver packages
    bridge.ts                      # authenticated worker-protocol transport
    composition.ts                 # paths, drivers, credential and process services
    package.json                   # private executable build, not another public API
  desktop/src/main/
    local-app-server.ts            # existing utility-process entry, retained
    local-app-server-supervisor.ts # existing lifecycle/bootstrap, retained
    desktop-credential-vault.ts    # existing native secret authority, retained
```

`harness-core`, `harness-codex`, `harness-claude` and
`harness-opencode` have private workspace
package manifests with explicit `./client`, `./settings` where relevant and
`./server` exports. Do not expose a root barrel that imports server code.
Driver server code imports only the core host contract and canonical schema/
protocol types, never `apps/*`, Electron, Brain services or React. Public client
metadata cannot import server entry points, Node or an external agent SDK.

Use source-local TypeScript module names consistent with the owning package.
Do not globally rename existing files or packages merely for upstream spelling.
Existing SDK/App Server exports and transports remain the product boundary;
new operations extend them rather than create `app-server-client`, a second
protocol package, or T3's parallel `client-runtime` beside the existing SDK.

OpenCode v2 is in initial scope: 048.L3 locally and 061.C6 in cloud. Its one
native adapter owns executable/version validation, private server supervision,
typed API/events, permissions, settings and authentication. It does not wait
for Codex or Claude. The earlier ACP transport/package proposal is superseded;
there is no ACP fallback for OpenCode. Generic ACP support can be independently
scoped later for agents whose native integration is ACP.

Use a generated per-instance native server password, distinct from model
provider credentials. Verify server.info and supported version before exposing
a ready instance. Establish the native SSE subscription before starting a
prompt; monitor liveness and reconcile interrupted delivery from native session
state. The volatile SSE feed alone is not durable history. Do not assume a
reconnect replays missed output or resend the prompt to recover it. Normalized
observations still use the canonical acknowledgement/journal path below.

## 4. Dependency and responsibility rules

```text
Web/Desktop renderer → SDK → App Server → existing local/hosted services
                                |
                         runtime-kernel
                                |
                      DelegatedHarnessPort
                        /               \
      in-process HarnessExecutionPort   CloudHarnessExecutionPort
                        |               |
                        |         private sandbox bridge
                        \               /
                    harness-core registry/session host
                    /             |                 \
            harness-codex    harness-claude    harness-opencode
                    |             |                 |
            Codex subprocess Claude SDK/process native v2 client/server
```

The kernel imports the delegated port and worker-protocol facts, never Node
driver implementations. `harness-core` may implement that port using type-only
kernel imports; the kernel has no reverse dependency on harness-core. Drivers
depend on core host contracts; only the two composition roots know concrete
drivers. The cloud supervisor entry is excluded from Worker build entry graphs.

Native and delegated execution are exclusive strategies selected at admission.
Extract common preparation/finalization from the existing RuntimeKernel only
where needed, keeping WorkspaceCoordinator, RuntimeLifecycleCoordinator,
ApprovalCoordinator and TurnArtifactSettlementCoordinator as owners. Delegated
execution never calls `ProviderPort.generateNext`, native tool execution or
native compaction in parallel with the external agent. Provider transcript
state is a continuation aid, not another LegionCode transcript authority.

Keep ordinary native inference in provider-core/execution-engine. A subscription
connection, model selection and an agent choice are separate identities. This
prevents an OpenAI model name from accidentally selecting the wrong agent loop
or payer and permits later SDK/CLI consumers without moving these modules.

## 5. Session, process and authentication identity

Persist a binding with environment/workspace/grant, canonical Thread ID,
driver kind, instance ID, selected connection ID, auth-owner generation,
external session/thread IDs, supported runtime version and policy identity.
Bind external Turn IDs to the exact canonical Turn/Run Attempt. Processes add
an ephemeral generation; replacing a process invalidates all old reply handles.

V1 uses one live harness session per owning thread/workspace/account binding.
No process multiplexing across users or accounts. Reuse across later turns only
when root, instance, continuation identity, credential source and effective
policy remain compatible. Persist identifiers and validated facts; never persist
live handles, AbortControllers, SDK query objects or bearer secrets in events.

Separate credential ownership from access-token version. A routine refresh for
the same account can update token material without pretending the account
changed. Revocation, account/source changes and replacement advance the owner
generation. Fence pending commands/replies immediately; a required process
restart has its own generation. Old refresh results cannot overwrite a newer
owner or resurrect a disconnected account.

Local CLI-owned credentials stay in their supported provider store. App-managed
credentials use the existing Electron vault. Cloud uses the existing encrypted
credential boundary. Extend its API-key-only record contract to a discriminated
key/OAuth/external-reference form and migrate its actual consumers together.
Do not add a separate token vault for each driver or misuse `apiKey` for JSON.

Persist connection identity independently of provider ID and instance identity.
Replace the current user/provider singleton constraint with connection-scoped
records in that migration; defaults refer to a selected connection rather than
overwriting another account. V1 needs explicit selection, not account rotation
or organization sharing. This prevents a second account from later requiring
another credential-storage architecture.

Choose the selected credential source explicitly and remove unrelated inherited
API-key/auth variables before child launch. Preserve the actual OS HOME; use
supported CODEX_HOME/CLAUDE_CONFIG_DIR values scoped to the selected instance.
V1 does not copy entire provider homes or import unrelated CLI transcripts.

HarnessHost also supplies an enforceable launch policy, not permission advice
in a prompt. The cloud composition uses a restricted execution identity and
filesystem policy with canonical Git metadata protected from delegated writes;
the host's Git service retains mutation authority. The Mac composition uses
the supported native sandbox policy for the pinned harness/OS and protects
resolved Git metadata, including worktree indirection, while permitting the
granted working-tree edits. Verify symlink/rename/alternate-index escape cases
at that execution boundary. A tool-name check or shell-string filter alone is
insufficient. If that boundary is unavailable for a pinned combination, expose
only the capabilities it actually enforces until the mutating gate passes.

## 6. Cloud process and transport construction

The inspected execution port supports bounded plugin tasks, not an interactive
agent session. Add a separate narrow delegated port; do not emulate approvals
by launching a new CLI for each message or by treating stdout as canonical
events. Local invokes the host in-process; cloud invokes the same host over a
private authenticated bridge defined in worker-protocol.

For the existing Cloudflare Sandbox 0.x backend, bootstrap the packaged Node
supervisor as a background process, wait for readiness, and use the Worker-side
WebSocket connection mechanism for bidirectional commands and observations.
Authenticate every bridge session to its lease, workspace, attempt and process
generation. Do not expose a public preview URL for the control port. The
[0.x WebSocket guide](https://developers.cloudflare.com/sandbox/sdk/guides/websocket-connections/)
documents this Worker-mediated connection; validate the exact locked SDK/image
combination before implementation. A future backend or SDK API change stays in
this transport adapter and composition, not the client or driver interfaces.

The [background-process guide](https://developers.cloudflare.com/sandbox/sdk/guides/background-processes/)
requires explicit lifecycle management for long-running work. Keep the sandbox
alive only under the active lease/approval-wait duration policy, with bounded
recovery and explicit release. Browser subscription lifetime never owns the
process. Worker restart reconnects to the same generation only after verifying
the durable binding and runtime liveness; it does not resend the last prompt.

The bridge carries typed observation sequence numbers and commit acknowledgements.
Before sending an observation, the host journals the unacknowledged frame with
its binding/process generation. The canonical append transaction records its
ingress identity; only after commit does the Worker acknowledge it. Reconnect
resends unacknowledged observations, which ingress deduplicates. This delivery
journal is pruned after acknowledgement and cannot answer product history or
decide lifecycle. It is not a second canonical event store. Bound journal size
and memory; overflow must backpressure or quiesce/fail explicitly, never drop
an approval, tool result or terminal observation.

During recovery, reconcile the verified prior generation's journal before
rebinding/resuming a new process; thereafter fence old callbacks. Provider work
that happened before a crash without recoverable evidence remains an unknown
outcome, not a reason to replay the action or manufacture a successful result.

The inspected Dockerfile builds as root and ends at `/root`. Add a dedicated
non-root execution identity with owned workspace/config directories for the
Node harness and its children. Keep required sandbox control-plane startup
privileges separate; do not blindly change the entire image USER and break the
SDK control process. Pin CLI/SDK versions in the image/lockfile, use the exact
runtime manifest for local health checks, and disable self-updates during runs.

An environment variable/auth file available to arbitrary commands of the same
OS identity is not secret from those commands. Keep personal credentials in
single-owner execution and exclude auth material from snapshots, review and
logs. Release proof must state and validate the actual process credential
boundary. Multi-user subscription sharing requires a separate authorization
decision and is outside this construction.

## 7. Durable execution, stopping and recovery

Adapt T3's durable-intent discipline to LegionCode's existing
`canonical_turn_admissions`, thread-input inbox, lifecycle append and local
writer. The inspected Postgres admission record already distinguishes pending,
running, recovery_required and settled execution and supplies claimExecution.
Reuse those identities and claims; do not build another event store or generic
outbox. Extend local persistence with the equivalent transactional binding and
claim behavior in its existing SQLite database.

The required ordering is authorization → admission/claim → frozen binding →
workspace lease/start snapshot → external start → validated observation append
→ live continuation. Acknowledging admission means accepted intent, not that
the external provider started or the Turn succeeded. A binding change and its
related canonical lifecycle evidence commit through the same existing writer
transaction where they must be atomic.

On process loss, start/steer/approval reply are process-bound operations with
possibly unknown outcomes. Mark recovery-required and inspect supported
external state; never automatically replay them. Only proven idempotent reads,
reattachment and artifact cleanup can retry. Canonical client-command retries
reuse their original identities and return the recorded result.

Stop has two phases: command accepted, then execution quiesced. Register the
attempt before starting provider I/O so an immediate Stop cannot miss it.
Interrupt the provider and await observed terminal/child cleanup; escalate to
bounded process-group termination if required. Keep the checkout lease until
mutating children stop and artifact settlement finishes. UI can show stopping;
it must not infer stopped from an HTTP acknowledgement.

Capture provider-completed time separately from artifact-finalized time. After
quiescence, use the existing artifact coordinator for immutable terminal
snapshots/diffs, settle pending tool/request state, append terminal facts once,
and release the lease. Late events must match the exact binding/generation;
late subagent events cannot be attributed to whichever Turn is now active.

Subscription exhaustion is a typed reason with provider-supplied reset data.
It does not select another account, model, agent or API-key payer. Unsupported
permission modes, resume, steering or questions are unavailable capabilities,
not emulated successes. Host policy cannot claim confinement based on prompts.

## 8. Construction order and acceptance

| Slice | Construct in final location | Real path required before completion |
| --- | --- | --- |
| Any first working harness slice | Shared schemas, delegated port/coordinator, core host, needed binding-store migration and the selected driver/composition | Real SDK/App Server Turn with approval/edit/test, Stop, durable replay and immutable review; no 057/058 completion dependency |
| Codex, 048.L1 / 061.C1 | Codex package with generated protocol and scoped authentication | Independent Codex acceptance; does not wait for Claude or OpenCode |
| Claude, 048.L4 / 061.C3 | Claude package and SDK runner using the shared contract | Independent Claude acceptance; subscription payer proof when provider access permits it |
| OpenCode v2, 048.L3 / 061.C6 | Native v2 server owner, typed client/SSE feed and OpenCode driver using the shared contract | Independent version/readiness/auth/prompt/approval/Stop/reconcile/review proof; no Codex/Claude predecessor |
| Other host composition for any ready driver | Reuse that driver/core package; add local composition or cloud supervisor/bridge and matching persistence adapter | Same contract in both placements; no driver copy or client placement branches |
| Connection/usage slices, 048.L2 / 061.C2/C4 | App Server operations, SDK client/read model, shared UI and existing vault extensions | Supported login/renew/revoke, truthful quota freshness and separate cloud compute attribution |
| Mac beta and cloud recovery | Existing 057 packaging and 061.C5, respectively | Installed-app and unattended-cloud proofs remain independently owned |

First implementation PRs must validate import graphs and runtime versions,
including no Node/Claude SDK imports in Worker/browser graphs. Use existing
boundary/type/lint/runtime/persistence checks and extend existing replay
assertions; AGENTS.md forbids new test files and test registrations. Required
scenarios include wrong-account ambient credentials, immediate Stop, stale
approval replies after restart/account change, refresh-vs-revoke races,
duplicate admission, denied permission, buffer overflow/reconnect, process
death after start, immutable review and two concurrent isolated threads.

Dependency upgrades can change generated wire types and driver mappings without
moving application ownership. Record upstream version, schema hash and exposed
capabilities in the adapter manifest. Persist transport family and compatibility
metadata with session bindings; verify them before resume. Upstream upgrades or
a future ACP driver stay behind the same host contract, without silent
transport switching or reusing an incompatible external session. See the
[stability rules](HARNESS-TRANSPORT-DECISION.md#6-architecture-that-stays-the-same-across-transports-and-placements).
A required change to protocol ownership,
lifecycle, persistence authority or package dependency direction requires an
explicit revision of this construction decision and its affected acceptance
proof. Product breadth alone is not a reason to introduce another architecture.

## 9. Relationship to existing repository instructions

Plans 048 and 061 consume this single construction map; Plan 057 remains the
Desktop completion authority. Their older execution-engine adapter placement
is superseded. Historical Plans 025/033 are not alternate package blueprints.
No actual capability-ownership migration is recorded until a wiring PR ships.

AGENTS.md also references `architecture/RUNTIME-ARCHITECTURE.md`; that file is
absent in the inspected main and integration refs. This scoped decision does
not invent or replace its missing broader content. Before implementation,
reconcile the missing reference with the repository's actual architecture
authority. Preserve unrelated checkout and ownership-ledger changes.
