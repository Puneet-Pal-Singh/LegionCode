# Codex, Claude Code and OpenCode v2 transport decision

Decision date: 2026-11-06, Asia/Kolkata.
Status: Research-backed target for Plans 048 and 061; no implementation or live
provider conformance is claimed. Read with the fixed package and ownership map
in [Harness integration construction](HARNESS-INTEGRATION.md).

## 1. Choice for the three execution paths

Use native integration for each built-in harness. Use the same driver package
in both execution hosts; Web and Mac cloud connect to the same hosted product
API. The Mac local App Server composes that driver with local host services.

| Harness | Web → cloud | Mac → cloud | Mac → local |
| --- | --- | --- | --- |
| Codex | `harness-codex`: Codex app-server over private stdio | Same cloud environment, driver and Thread as Web | Same driver; local app-server subprocess |
| Claude Code | `harness-claude`: official Claude Agent SDK streaming query | Same cloud environment, driver and Thread as Web | Same SDK runner; local process and credential store |
| OpenCode v2 | `harness-opencode`: private native v2 server, typed client and SSE | Same cloud environment, driver and Thread as Web | Same server/client driver; local process and credentials |

Here, native integration means running that external harness's complete agent
loop through its own interface. LegionCode Native remains a separate execution
choice, with its own inference-provider routes and explicit payer selection.

This is a product-fit decision, not a measured reliability ranking. Native
gives us direct control of the account, execution and recovery interfaces that
these three runtimes already expose. It costs three integration implementations
and their upstream maintenance. ACP offers substantial shared client work and
is a good extension route for other agents; it is not rejected for cloud use.

The requested stable architecture is the host/driver/runtime boundary, not a
promise that upstream APIs will never change. Version/schema updates stay
inside drivers and host transports wherever possible. No choice of ACP or
native can guarantee zero future API or product-contract changes.

## 2. What ACP changes, and what it leaves to LegionCode

[ACP v1](https://agentclientprotocol.com/protocol/v1/overview) supplies JSON-RPC
session/prompt operations, streamed updates, cancellation and permission
requests, with negotiated filesystem, terminal and other capabilities. It is
not confined to desktop editors. In cloud, its **client** would run in our
Node execution host beside the agent, forwarding normalized requests through
the existing runtime. The browser would remain a product client.

ACP does not itself provide tenant authorization, hosted credential custody,
compute billing, an OS sandbox, cloud scheduling, durable LegionCode events or
immutable review artifacts. Native requires those same services. Neither
stdio nor SSE supplies exactly-once external execution after a crash.

ACP v1 is currently the published latest protocol; ACP v2 is a draft. OpenCode
**v2 is the product version** and currently serves ACP protocol **v1**. The two
version numbers are unrelated. Claude Agent SDK's removed TypeScript v2 preview
is also unrelated; use the maintained `query()` interface.

Distinguish three layers when evaluating a capability:

1. ACP baseline and optional negotiated methods.
2. Draft RFDs and vendor/client extensions, including `_meta` payloads.
3. The specific adapter's mapping to its underlying runtime and pinned version.

A feature in a bridge README may require extensions we must implement. That
does not make the feature absent or unreliable; it changes compatibility and
maintenance obligations. Conversely, a native method existing upstream does
not mean LegionCode can advertise it before policy and replay acceptance.

| Engineering tradeoff | ACP | Native interfaces |
| --- | --- | --- |
| Shared implementation work | Common session, content, permission and terminal client; bridge-specific auth/metadata/extensions still need handling | Three protocol/SDK mappers; process, isolation, delivery, canonical requests and UI remain shared |
| Upstream changes | ACP version plus runtime/bridge/extension compatibility; OpenCode's first-party bridge shares its executable release | Runtime/schema/SDK compatibility owned directly by each driver |
| New vendor features | Available when represented by the adapter and negotiated capabilities | Available when represented by our driver and accepted by the product contract |
| Performance | An extra translation layer for bridged agents; no benchmark here establishes a material latency/resource penalty | Fewer translation boundaries for Codex/Claude; actual resource and latency budgets require measurement |
| Cloud scale and durability | Host placement, tenant isolation, process limits, persistence and lease policy determine these | The same host responsibilities apply; native HTTP or stdio supplies no scheduler or durable product log |

The accepted cost of this choice is maintaining all three native integrations.
If the product instead prioritized broad agent-registry coverage with a common
feature subset, ACP would become a stronger default. The requested built-in
account, workspace, recovery and review behavior determines this decision.

## 3. Codex: native app-server versus current ACP bridge

The current [codex-acp README](https://github.com/agentclientprotocol/codex-acp/blob/519c2671bfe8266b7625b1cebde7657b5f6d1303/README.md)
explicitly starts Codex app-server and translates it to ACP. The maintained
repository is `agentclientprotocol/codex-acp`; the archived Zed Rust adapter is
not the baseline for this comparison.

| Concern | Native app-server | Current ACP bridge | Decision consequence |
| --- | --- | --- | --- |
| Dependency path | Host → app-server with schemas generated by that exact binary | Host → ACP adapter → app-server; the adapter bundles a compatible Codex dependency | Native removes one translation/version boundary. ACP saves us much of that translation work. |
| Authentication and subscription usage | Account login/read/logout, token refresh requests and account rate-limit RPC/notifications are exposed directly | ChatGPT/API-key/gateway auth, quota metadata and token accounting are implemented | ACP does support plan auth/usage; native is preferable for our typed connection and account-status UI without adopting bridge-specific metadata. |
| Prompt and control | Native Thread/Turn IDs, start, steer, interrupt and reverse RPC | New/load sessions, prompt/cancel, plus steering and question extensions | Keep exact native IDs and operation outcomes in the driver; neither path can safely resend an ambiguous start or steer. |
| Permissions and questions | Native command/file/permission requests and elicitation | Permission choices and form elicitation are mapped, with richer optional presentation | Both need origin-scoped, single-use replies and provider-enforced policy. ACP client-side file access alone cannot confine agent shell writes. |
| Subagents and background work | Native lifecycle and background-terminal interfaces; some controls require experimental opt-in | Native subagent sessions after negotiation, background-task and targeted-stop support through extensions | ACP is capable, but these are not uniform v1 baseline features. Direct integration avoids making their extension contracts our built-in dependency. |
| Recovery | Read/resume stored threads and reconcile native terminal/account state | Bridge reconstruction/replay and its own recovery handling sit over that state | LegionCode still owns admission, delivery acknowledgements, fencing and immutable review in both cases. |

Evidence beyond the README: the bridge's
[app-server client](https://github.com/agentclientprotocol/codex-acp/blob/519c2671bfe8266b7625b1cebde7657b5f6d1303/src/CodexAppServerClient.ts)
issues native start/resume/steer/interrupt and account requests;
[steering](https://github.com/agentclientprotocol/codex-acp/blob/519c2671bfe8266b7625b1cebde7657b5f6d1303/docs/steering.md)
uses `_session/steering`, including a negotiated host-owned idle fallback;
[token accounting](https://github.com/agentclientprotocol/codex-acp/blob/519c2671bfe8266b7625b1cebde7657b5f6d1303/src/TokenCount.ts)
maps native cumulative/request counts to ACP prompt usage.

**Choose native app-server over stdio.** Generate and pin its schemas; keep
experimental methods behind explicit capability gates. The current official
[transport documentation](https://learn.chatgpt.com/docs/app-server#protocol)
marks the network WebSocket transport experimental and unsupported; it does
not apply that warning to all stdio app-server operations. Our cloud bridge
is a separate authenticated LegionCode transport, not an exposed Codex socket.
Do not make beta background-terminal controls a prerequisite for a basic
foreground integration, or claim full background support without proving them.

## 4. Claude Code: official Agent SDK versus current ACP bridge

The current [claude-agent-acp README](https://github.com/agentclientprotocol/claude-agent-acp/blob/85aec26ef984a421fe8064ce43f60138a3372384/README.md)
uses the official SDK and supports rich tool review, nested subagents,
interactive/background terminals and extensions. It is a substantive
integration, not merely CLI text parsing.

| Concern | Native Agent SDK | Current ACP bridge | Decision consequence |
| --- | --- | --- | --- |
| Dependency path | Host imports maintained streaming `query()`/Query API and supervises its CLI | ACP adapter imports the same SDK and owns a second session/control mapping | Native is the shortest supported application integration; ACP shares client infrastructure across agents. |
| Permissions and input | `canUseTool`, hooks, supported permission modes and SDK input callbacks | Permission requests, editable choices and durable effects; richer AIR presentation is negotiated | Keep policy at the native SDK/process boundary and present only modes it enforces. We do not need an additional UI-extension contract for the built-in. |
| Sessions and streaming | Resume/session inspection, streamed input, results and task notifications | Load/resume/replay, child session reconstruction and streaming updates | Both are viable. Native preserves SDK result/task identities directly; neither replaces canonical product history. |
| Stop and background tasks | `interrupt()`, interrupt receipts where supported and `stopTask()`; results do not prove every child exited | Parent cancel can preserve background children and commands; child cancel stops a specific task | Define LegionCode Stop explicitly. A successful cancel response or completed foreground prompt is insufficient to release a mutating workspace lease in either integration. |
| Steering and protocol evolution | SDK streaming input semantics, version-gated by our runner | `_session/steering` extension; the bridge currently documents steering and AIR extensions as v1-only when serving draft ACP v2 | Native avoids this extra version/capability intersection. Do not treat changing SDK input as universal steering success. |
| Account and usage | Account info, result token/cost fields and rate-limit observations; availability varies by version/auth route | Maps limit data to `_claude/rateLimit`; `/usage` structured formatting calls a deliberately unstable SDK control method | Neither grants a dependable full quota dashboard automatically. Expose supported fields with freshness; experimental quota reads remain optional. |

The pinned bridge [manifest](https://github.com/agentclientprotocol/claude-agent-acp/blob/85aec26ef984a421fe8064ce43f60138a3372384/package.json)
uses SDK `0.3.318` and ACP SDK `2.4.0`; these are research pins, not approved
LegionCode release versions. Its [source](https://github.com/agentclientprotocol/claude-agent-acp/blob/85aec26ef984a421fe8064ce43f60138a3372384/src/acp-agent.ts)
handles interrupt races, maps `rate_limit_event`, and formats `/usage` using
`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`. This is evidence
against promising a stable quota endpoint from either transport.
Its [background-work module](https://github.com/agentclientprotocol/claude-agent-acp/blob/85aec26ef984a421fe8064ce43f60138a3372384/src/background-work.ts)
also preserves work that legitimately outlives the foreground prompt.

**Choose the official Agent SDK streaming interface.** The maintained
[TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)
provides query interruption, background-task control and account/session
operations. Maintain a long-lived input/session runner as required for controls;
do not spawn a fresh `claude -p` invocation for every user interaction. SDK/CLI
upgrades still require acceptance, especially interrupt receipts and task races.

Subscription permission and the supported cloud connection route are separate
from protocol choice. The [official overview](https://code.claude.com/docs/en/agent-sdk/overview)
still requires prior approval to offer third-party claude.ai login/rate limits.
Neither an ACP bridge nor another product's use supplies LegionCode approval.
Plan 061 retains that route-specific release gate without blocking other drivers.

## 5. OpenCode v2: native API versus first-party ACP

OpenCode is the closest decision. Its ACP implementation is first-party and
ships with the same executable, so it avoids the separate third-party bridge
dependency present for the other two. It is a credible alternative for a
product whose principal goal is a common ACP agent surface.

| Concern | Native v2 API/client | First-party `opencode acp` | Decision consequence |
| --- | --- | --- | --- |
| Hosting | Own authenticated private server, readiness, client and SSE lifecycle | ACP process starts its own private server; ACP uses stdio with no network port | ACP simplifies launch/auth plumbing for the control channel. Both still run the full OpenCode server/core locally or in the cloud host. |
| Authentication | Direct host provider/auth APIs and configured credential sources | Uses existing host credentials; terminal login/reconnect is supported, rather than collecting credentials in ordinary `authenticate` | ACP does not supply a ready Web subscription-connect flow. Native gives our connection service a direct typed integration; supported provider flows still need validation. |
| Session controls | Typed session reads, active state, messages, model/agent selection, prompt/control and execution events | New/load/resume/fork/list/close/delete, config options and one active prompt per session | ACP covers the core conversation flow well. Native avoids mapping back from the ACP presentation when reconciling execution and session state. |
| Approvals and questions | Typed native request/response state | Permission requests and negotiated form elicitation | Both can serve interactive cloud approvals through our host. Neither is an OS isolation boundary. |
| Child/background work | Direct session hierarchy and execution lifecycle | Child updates use `opencode/child-session` metadata; ACP also consumes work beyond a foreground turn | ACP does not inherently lose subagents. Native exposes the underlying identifiers/events directly for our attempt attribution. |
| Usage | Native measured session/message token/cost data | End-turn usage uses a draft RFD and excludes child sessions; `usage_update` cost is session-total | Neither implies account-wide subscription allowance. Aggregate only identified non-overlapping measurements and label unknown quota honestly. |
| Reconnect and drift | SSE is volatile; client must subscribe before work, monitor and reconcile from native state | The first-party ACP layer performs its own native subscription, replay and translation | ACP absorbs some maintenance, but does not turn the stream into a durable LegionCode event feed. Native needs explicit schema/version checks and gap handling. |

The [official ACP reference](https://opencode.ai/v2/docs/cli/acp/) documents
these capabilities. Source confirms the layering:
[agent](https://github.com/anomalyco/opencode/blob/76ff9a6ab25fca4b8f0f5c43e4ef12bd0c10cc3e/packages/cli/src/acp/agent.ts),
[session subscriptions](https://github.com/anomalyco/opencode/blob/76ff9a6ab25fca4b8f0f5c43e4ef12bd0c10cc3e/packages/cli/src/acp/sessions.ts),
[turn/cancellation handling](https://github.com/anomalyco/opencode/blob/76ff9a6ab25fca4b8f0f5c43e4ef12bd0c10cc3e/packages/cli/src/acp/turn.ts)
and [event/usage translation](https://github.com/anomalyco/opencode/blob/76ff9a6ab25fca4b8f0f5c43e4ef12bd0c10cc3e/packages/cli/src/acp/translate.ts).
Its cancel path distinguishes interrupt acknowledgement from cleanup and uses
a bounded drain. LegionCode must still verify quiescence before settlement.

**Choose the native v2 server and typed Promise client** for this product's
full managed workspace, recovery and usage integration. This is also the T3
built-in approach. The [client manifest](https://github.com/anomalyco/opencode/blob/76ff9a6ab25fca4b8f0f5c43e4ef12bd0c10cc3e/packages/client/package.json)
exports Promise and Effect entry points; T3's Effect client does not require a
LegionCode framework migration. Reject v1/unknown installations, pin a matching
2.x server/client/protocol set and authenticate readiness before prompting.

The native [session protocol](https://github.com/anomalyco/opencode/blob/76ff9a6ab25fca4b8f0f5c43e4ef12bd0c10cc3e/packages/protocol/src/groups/session.ts)
and [bounded event feed](https://github.com/anomalyco/opencode/blob/76ff9a6ab25fca4b8f0f5c43e4ef12bd0c10cc3e/packages/server/src/event-feed.ts)
also contain experimental surfaces and overflow failure behavior. Use only
required, proven capabilities. Subscribe before starting, reconcile gaps and
fail unknown outcomes explicitly; a native connection is not intrinsically
more durable than ACP. No native/ACP fallback is selected during recovery.

## 6. Architecture that stays the same across transports and placements

```text
Web ───────────┐
Mac cloud ────┴─ SDK → hosted App Server/runtime → private bridge → Node host
Mac local ────── SDK → local App Server/runtime ────────────────→ Node host
                                                                  |
                                                    harness-core + one driver
                                                /            |             \
                                      Codex app-server   Claude SDK   OpenCode v2
```

The [construction map](HARNESS-INTEGRATION.md#3-fixed-package-and-directory-map)
is retained. `harness-core` owns host services, instance/session lifecycle and
process supervision. `harness-codex`, `harness-claude` and `harness-opencode`
own wire/SDK types and translation. Runtime, persistence, credentials, Git,
artifacts, public SDK and shared UI keep their existing canonical owners.

The following rules are implementation requirements, not an extra foundation
milestone:

- Public SDK/events expose product operations and capabilities, never Codex
  JSON-RPC, Claude Query objects, OpenCode HTTP/SSE or ACP wire envelopes.
  No generic raw-provider-call endpoint or provider-kind branches in clients.
- Core distinguishes driver implementation, configured instance, selected
  connection, external session and ephemeral process generation. Placement is
  an environment binding, not a duplicate driver kind or UI runtime.
- Persist transport family and runtime/schema/adapter compatibility metadata
  with external bindings. Resume must verify compatibility. A future driver
  transport switch never reuses an active session merely because IDs look
  alike, replays a prompt or triggers silent cross-placement migration.
- Capability records separate support from current availability and experimental
  status. Gate steering, questions, resume, child controls, quota and policy
  modes independently; retain provider option IDs and explicit denial behavior.
  Additive capability/projection evolution must not move canonical ownership.
- Account/status reads use supported lightweight host APIs and bounded refresh.
  Background status checks must not launch a login, execute hooks/MCP or start
  billable inference. If safe reads are unavailable, show unknown or require
  an explicit user action.
- Stop means quiesce the attempt's work, including mutating descendants. A
  foreground prompt result, ACP cancel notification or SDK interrupt receipt
  alone cannot finalize artifacts. Track still-running work, retain its lease
  and event ownership, then drain or explicitly stop it; use bounded process
  termination if required. Never silently discard provider background work.
- All observations use the existing canonical append/acknowledgement path.
  Provider history is recovery evidence; it cannot become a second product
  event store. Requests/replies remain bound to their originating generation.

A later generic `harness-acp` driver may implement the same host contract in its
own package when a real ACP agent is delivered. It would own negotiation,
extensions and transport conformance. It would not require a second kernel,
database, cloud gateway, renderer architecture or copies of these three
drivers. No empty ACP package is requested now and no user session silently
changes transport to mask an integration error.

Cloud execution outlives either UI connection under the hosted lease. Mac cloud
reopens Web's same hosted Thread. Mac local uses the Mac's granted repository,
processes, credentials and local persistence; it requires that Mac to remain
available. Local/cloud credential authorizations remain separate. Pairing and
cross-environment handoff remain later explicit scope.

## 7. Delivery and evidence gates

Plans 048 and 061, each harness and the Mac work can proceed independently.
Plan 057/058 completion, another harness, generic ACP support and Native's
golden loop are not predecessors. The first working driver introduces the
needed shared contracts in their final packages. All three are initial scope.

For every driver, prove Web/cloud, Mac/cloud and Mac/local through real product
paths before advertising that complete matrix. Required evidence includes:

- Authenticated selected-account Turn with approvals/denial/questions where
  supported, edit/test output and immutable review; prove no second agent loop.
- Immediate Stop before provider start, Stop during an approval and Stop with
  children/background writers; late results and duplicate terminal callbacks.
- Browser disconnect, cloud bridge reconnect, process death after a possibly
  accepted prompt, host restart/resume and SSE/journal overflow or delivery gap.
- Wrong ambient account, refresh versus revoke, stale approval after restart,
  incompatible runtime/schema and two concurrently isolated workspaces.
- Reported versus unavailable account quota, child/session token attribution,
  quota exhaustion without payer fallback and independent cloud compute usage.

Use existing assertion/fixture locations under AGENTS.md's test restrictions.
Do not claim a live ACP/native reliability or latency comparison: this review
inspected source and official contracts, not authenticated side-by-side runs.
Runtime release pins require revalidation and real-provider replay evidence;
researching HEAD is not approval to auto-install or track HEAD in production.

## 8. Research revisions and T3 alignment

These revisions supplement the earlier construction review. They are fixed
research snapshots inspected on 2026-11-06, not an exhaustive security audit.

| Repository | Revision | Inspected material |
| --- | --- | --- |
| Codex OSS | `55897425e839d943a744c658701445ff732568a0` | app-server README; official current account/transport/schema documentation |
| Codex ACP | `519c2671bfe8266b7625b1cebde7657b5f6d1303` | README, manifest, app-server client, steering, quota and token translation |
| Claude Agent SDK TypeScript | `040a7f855da8261c795d975e116f40bb042334f7` | README/changelog; current official TypeScript API and hosting/overview docs |
| Claude ACP | `85aec26ef984a421fe8064ce43f60138a3372384` | README/manifest, session/prompt/interrupt/usage implementation and background work |
| OpenCode v2 | `76ff9a6ab25fca4b8f0f5c43e4ef12bd0c10cc3e` | first-party ACP modules, native session/event protocol, event feed and client exports |
| T3 Code | `291bcc392c421902cb18b2bf39023bdcae6d5cbe` | provider construction guide and native OpenCode v2 client/server |

T3 is **hybrid**: its [provider guide](https://github.com/pingdotgg/t3code/blob/291bcc392c421902cb18b2bf39023bdcae6d5cbe/docs/internals/adding-a-provider.md)
directs ACP agents to a shared ACP adapter and other protocols to dedicated
native adapters, with capability-driven clients. Its native OpenCode
[client](https://github.com/pingdotgg/t3code/blob/291bcc392c421902cb18b2bf39023bdcae6d5cbe/packages/provider-opencode/src/server/v2/OpenCode2Client.ts)
subscribes before work because events are volatile; its
[server owner](https://github.com/pingdotgg/t3code/blob/291bcc392c421902cb18b2bf39023bdcae6d5cbe/packages/provider-opencode/src/server/v2/OpenCode2Server.ts)
verifies authenticated server-info readiness. Adopt those boundaries and honest
capabilities. Neither T3's popularity nor a shared directory shape proves
LegionCode's reliability; our cloud/local conformance remains required.
