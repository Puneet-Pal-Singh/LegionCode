# LLD 048 — Local Harness Integration And ChatGPT Plan Usage

Date: 2026-10-07 (Asia/Kolkata)
Updated: 2026-11-06 (Asia/Kolkata): independent Codex, Claude Agent and OpenCode
v2 integration, with local/cloud execution and no Plan 057/058 completion gate.
Status: Proposed design; no implementation has started under this LLD.
Parent: [Plan 048](../048-PAIRED-LOCAL-HOST-AND-MULTI-HARNESS-ADOPTION-PLAN.md).

Construction authority, revised after deep source inspection on 2026-11-06:
[Harness integration construction](../../../../architecture/HARNESS-INTEGRATION.md).
It pins T3 Code, Codex OSS and OpenCode v2 revisions and fixes the package/file
map, import direction, process/credential ownership and delivery/recovery rules.
Use its final package locations in the first working slice.

Historical execution tracking, 2026-10-19:
[#526 — external harnesses](https://github.com/Puneet-Pal-Singh/LegionCode/issues/526)
targets dev after [#485](https://github.com/Puneet-Pal-Singh/LegionCode/issues/485)
(Plan 058) and [#486](https://github.com/Puneet-Pal-Singh/LegionCode/issues/486)
(resumed Plan 057). Plan 057 section 8's approved addendum orders 058 before
unfinished Desktop execution. Native inference is independently tracked by
[#525](https://github.com/Puneet-Pal-Singh/LegionCode/issues/525).

The blanket ordering recorded above is superseded for this subscription
milestone by section 1 below. Remote issues have not been edited. Cloud delivery
is separately planned in [Plan 061](../061-CLOUD-HARNESS-INTEGRATION-PLAN.md).

## 1. Decision and entry gate

Integrate Codex, Claude Agent and OpenCode v2 as three independently executable
tracks through the existing SDK/App Server/runtime boundaries. None waits for
another harness, Plan 057, Plan 058 or the Native golden loop to finish.
The [ACP versus native decision](../../../../architecture/HARNESS-TRANSPORT-DECISION.md)
sets the built-in choices: Codex app-server over stdio, official Claude Agent
SDK streaming query, and OpenCode v2 private native server/typed client/SSE.
Use these same Node packages for cloud and local hosts; Mac cloud consumes the
same hosted SDK/Thread as Web. Generic ACP remains a separately scoped driver
behind the shared host contract, with no native/ACP recovery fallback.
ACP is Agent Client Protocol; it does not itself supply subscription
entitlements, credential custody, persistence or an OS sandbox. Its current
bridges support rich permissions/subagents/background work; native is selected
for direct account/execution/recovery access, not presumed ACP unreliability.

The user's 2026-11-06 clarification makes integration independent. Required
capabilities are delivered and proved by each harness slice:

- Shared adapter/protocol work starts in the first real local or cloud slice
  that consumes it; no disconnected interface-only foundation PR.
- Local read-only execution needs granted workspace identity, local admission,
  durable append/replay and a supervised process binding.
- Local mutation needs enforceable workspace/shell/Git policy, approval and
  interruption, checkout lease, terminal settlement and immutable artifacts.
- If a required capability is missing, wire it through the existing canonical
  owner in that integration slice; do not wait for a 057/058 milestone or
  introduce a duplicate runtime, store or client authority.
- Integration acceptance runs through SDK → App Server → runtime → harness →
  persisted review using a real caller. Installed Mac feature availability
  separately requires packaged product proof; signing, updates and beta closure
  remain 057 responsibilities and do not block adapter or cloud implementation.

Plan 057's LLD remains authoritative for Desktop completion; Plan 058 owns Web
extraction. Reuse current reviewed shared contracts and coordinate overlapping
edits, without scheduling harness implementation behind unfinished extraction
or native-runtime work. Neither plan is a predecessor of 048/061.

Do not require the broader Plan 056 migration, cloud relay, mobile, or an
outbound LegionCode ACP server for accountless local integration. Connected
remote control retains the additional Plan 047 Gate C and Plans 032/048 gates.

### Independent inference-provider track

Users must be able to choose either of these OpenCode integrations:

| User choice | Agent loop and tools | Model access | Delivery owner |
| --- | --- | --- | --- |
| LegionCode Native + OpenCode Zen/Console | LegionCode native runtime | Direct inference API with the user's key and pay-as-you-go balance | Plan 027 |
| LegionCode Native + OpenCode Go | LegionCode native runtime | Direct Go inference API with the user's subscription-backed key | Plan 027 |
| OpenCode v2 harness | OpenCode v2, with canonical host validation | Models/provider accounts configured in that harness, including Zen/Go where available | Plan 048.L3 through native v2 server/client |

Native Zen/Go inference does not install or launch OpenCode, communicate over
ACP, or depend on the external-harness adapter. The provider track can ship
against the existing cloud native runtime once its provider/runtime acceptance
passes; this LLD's local capability gates apply to external harness integration,
not to adding inference providers. Desktop consumes the same provider route
when its native runtime is ready.

Plan 027 owns the provider implementation and its concrete Zen/Go slices. This
LLD coordinates the user choice without creating another provider plan or
changing canonical ownership. Both paths use the existing SDK/projections,
approval, artifact and Git boundaries, with truthful loop ownership.

## 2. What T3 Code actually does

Source inspected: upstream `pingdotgg/t3code`, commit
`c9b21b28e2cebc4c9cbd80726e757df36309dea8`, on 2026-10-07.
Commit-pinned links below support these findings; branch HEAD may change.

| Responsibility | Verified source behavior |
| --- | --- |
| Driver registry | Separate Codex, Claude, OpenCode, Cursor, and ACP-registry drivers; driver kind is distinct from configured instance |
| Codex | Codex app-server client, with native Thread/Turn/approval/event mapping |
| Claude | `@anthropic-ai/claude-agent-sdk` query interface |
| OpenCode | Both v1 and v2: version probing selects separate native adapters/server protocols within one OpenCode driver |
| Cursor | Official Cursor SDK; the inspected driver supports browser login or API key |
| Generic agents | Separate ACP registry driver and ACP session runtime |
| New ChatGPT sign-in | Host/account registration, PKCE, identity/scope checks, protected credentials, refresh serialization, and managed Codex launch |

This is a hybrid architecture. T3's source does not establish that its native
Codex/Claude/OpenCode integrations all travel through ACP. Its existing
installed-CLI login path and its app-managed ChatGPT plan-sharing path are
different configurations.

T3's OpenCode driver selects `OpenCodeAdapterV2` for the OpenCode v1 runtime
and `OpenCode2AdapterV2` for OpenCode v2. The `AdapterV2` suffix denotes T3's
adapter architecture, not the OpenCode product version. Its update metadata
also distinguishes `opencode-ai` (v1) from `@opencode/cli` (v2).

Adopt driver/instance separation, process supervision, capability negotiation,
structured event translation, and host-owned credentials. Adapt them to
LegionCode's canonical owners. Do not copy T3's event store, lifecycle model,
Effect framework, large adapters, or every OpenCode generation branch.

## 3. Product and transport choices

| Harness | Initial transport | Authentication | Release order |
| --- | --- | --- | --- |
| LegionCode Native | Existing runtime/provider ports | Existing BYOK route | Separate 057 scope; not an external-harness prerequisite |
| Codex | `codex app-server`, bidirectional stdio RPC | Existing Codex login in L1; app-managed ChatGPT plan consent in L2 | Independent L1/L2 track |
| OpenCode v2 | Native v2 server and typed client/events, matching T3 | OpenCode v2's own supported provider authentication | Independent L3 track in initial scope |
| Claude Agent | Claude Agent SDK against the selected supported Claude runtime | Selected local login/subscription subject to provider release gate; explicit API key is a separate billing route | Independent L4 track |
| Cursor | Supported official Cursor SDK | Validated supported account/API-key route | Later slice |
| Other ACP agents | Shared ACP client adapter | Advertised auth method, validated by host | Later independent scope |

Use T3's native OpenCode v2 integration shape from the first slice: supervised
private server, typed native client, event mapping and session controls. This
supersedes the earlier ACP choice; do not implement both transports or silently
fall back. Generic ACP remains a separately scoped later integration.

LegionCode targets OpenCode v2 only. Probe the actual executable's product
version and require a supported, pinned 2.x release before admission. Reject
v1 or an unknown generation with an explicit setup error; do not copy T3's
v1 compatibility/default path. Pin matching native client/protocol packages and
verify server-info readiness before allowing work.

Claude's current official sources differ in scope. Its help article says SDK,
`claude -p` and third-party usage still draw from subscription limits; its SDK
overview and quickstart still require prior approval for third-party products
offering claude.ai login or rate limits. See the dated sources in section 10.
Plan the subscription adapter and UX now; obtain documented clarification or
approval covering LegionCode before enabling that product route. A CLI login,
T3 implementation or Amp announcement does not establish that approval.
Supported API-key use can prove the adapter independently, but is not completion
of the requested Claude subscription support. Follow the SDK's product naming
guidance when labeling the integration.

Choose environment and agent/harness first. For LegionCode Native, choose a
provider connection (including Zen/Console or Go) and a model from that
connection. For an external harness, choose its instance and a model from its
advertised catalog; provider configuration is harness-owned where supported.
Display auth state, capability limits, install/version health, and exact
billing route. Freeze the complete selection on each Run Attempt; an account,
provider, billing-route or harness change cannot mutate an active attempt.
Never switch from Native to the OpenCode harness, or Go to pay-as-you-go, automatically
when a request fails. Explicit provider-side balance overage remains the user's
OpenCode account setting and is not a LegionCode route fallback.

## 4. Canonical wiring and ownership

```text
Web / Desktop shared client-ui
             |
       @legioncode/sdk
             |
   LegionCode App Server
             |
  runtime admission + delegated-harness execution port
             |
   configured harness instance registry
      /          |            \
 Codex RPC   OpenCode v2 API   Claude SDK
             |
 normalized external facts → runtime validation
             |
 canonical durable append → SDK continuation/replay
             |
 canonical artifacts/diff → shared review → Git service
```

LegionCode App Server and Codex app-server are different processes. The former
is our client boundary; the latter is a child harness behind an adapter.

| Responsibility | Owner |
| --- | --- |
| Canonical admission, IDs, lifecycle, terminal settlement | Existing RuntimeKernel/lifecycle coordinators |
| Durable append and replay cursor | Plan 057 local persistence and existing event store |
| Commands, authentication, subscription delivery | Existing App Server handlers/ports |
| Harness configuration and instance health | Host-side registry through App Server queries |
| Provider-specific protocol and subprocess/SDK session | Selected harness adapter |
| Workspace grants, leases, snapshots, artifacts and Git | Existing workspace/runtime/artifact/Git services |
| Approval decisions | Existing permission policy and ApprovalCoordinator |
| Native protected credentials | Existing Electron main credential vault through a narrow host port |
| Display-safe state and interaction | SDK projections and shared client-ui |

Use the construction authority's fixed map: canonical public data in
platform-protocol, private bridge schemas in worker-protocol, delegated ports
and lifecycle coordination in runtime-kernel, concrete Node integrations in
harness-codex/harness-claude/harness-opencode and host machinery in harness-core. App
Server, SDK and client-ui keep their existing roles. Local and cloud consume
the same driver packages from the start. Do not put the drivers inside
execution-engine temporarily or add empty protocol/registry/client-runtime
packages from Plan 025's historical proposal.

The current runtime calls model-provider steps through ProviderPort; that is
not sufficient for a complete external agent loop. Introduce a narrow delegated
execution port whose callbacks supply validated facts to existing lifecycle
coordinators. Do not simulate the entire external harness as one fake model
call or run the native agent loop alongside the external loop.

## 5. Required harness contract

Separate driver kind, configured instance, host process generation, external
session ID, and external turn ID from LegionCode Environment/Workspace/Thread/
Turn/Run Attempt IDs. Persist the binding through the existing local writer.
External continuation IDs do not become canonical lifecycle IDs.

The port needs initialize/probe, start-or-resume, prompt, interrupt, approval
decision, user-input response where supported, normalized facts, and dispose.
It must report protocol/version and exact capabilities for models, modes,
images, questions, approvals, terminal access, resume/fork, and context telemetry.
Unsupported operations return typed results and remain unavailable in UI.

Admission resolves the workspace from its durable grant, acquires its execution
lease, captures the start snapshot, and freezes harness/auth configuration.
Adapters receive the resolved root and effective policy, not an arbitrary
renderer path. Only one write-capable attempt owns a checkout at a time.

For each external fact: validate schema, active binding and process generation;
map to canonical content; append through the runtime; then deliver continuation.
Fence stale callbacks after restart, reject duplicate terminal results, settle
pending requests, and import terminal evidence through canonical artifact ports.
Provider diffs may enrich provenance; completed review uses captured artifacts.

Forward interruption, wait for observed terminal behavior, then settle through
the runtime. A lost process or timeout settles explicitly as failed/interrupted
according to runtime policy; it cannot become successful merely because the
stream closed. Restart may resume only a verified external session, never
silently resend a prompt whose execution outcome is unknown.

External harness tools run inside that harness. The host translates supported
approval callbacks and sets enforceable harness policy before starting work.
Do not claim every tool passes through LegionCode's native tool executor. When
root, approval, or Git restrictions cannot be enforced, disable the affected
capability. ACP permission prompts alone do not confine a subprocess.

Keep branch/worktree/commit/PR mutations in LegionCode Git services. Exclude
such commands from delegated shell execution and enforce the restriction at
the actual supported execution/sandbox boundary; prompt instructions alone
are insufficient. A write-capable adapter cannot pass acceptance until this
boundary and workspace escape rejection are demonstrated.

Context/compaction/token telemetry is `harness_reported`. Do not manufacture
native context budgets or claim compaction control the harness does not expose.

## 6. ChatGPT sign-in and subscription use

Deliver two explicit Codex instance auth configurations through the same adapter:
existing Codex-managed authentication and LegionCode-managed ChatGPT plan usage.
There is no automatic credential or billing fallback between them.

Existing CLI credentials remain in their provider-owned store; L1 does not
read, export, or rewrite their secrets into LegionCode events or preferences.
The existing Electron vault protects the app-managed tokens added in L2.

The new sign-in path requests identity and permission to use eligible ChatGPT
plan allowance. Identity-only sign-in is insufficient. Keep this connection
separate from a LegionCode cloud account; local use stays accountless with
respect to LegionCode.

Host-owned flow:

1. Persist one opaque `ext_agent_host_id` per installation; reuse across restart.
2. Open browser authorization with fresh state, nonce and PKCE. For first
   registration use the documented dynamic-client flow and LegionCode app name.
3. Validate the loopback callback and save the issued client ID before exchange.
4. Verify ID-token signature/issuer/audience/nonce and the granted plan-use scope.
5. Protect tokens in the existing vault. SDK/UI expose only redacted status and
   account labels. Serialize refresh and replacement per account registration.
6. Launch Codex with the access token in the child environment and a documented
   Responses provider; never place it in process arguments or project config.
7. Refresh before expiry; restart/fence the child with the replacement token and
   resume the saved external thread after any active attempt settles safely.
8. Handle decline, cancellation, revocation, account changes and expired refresh
   credentials explicitly. Provide disconnect and Manage usage actions.

Follow the official Codex configuration: `wire_api="responses"`,
`requires_openai_auth=false`, `supports_websockets=false`, Responses base URL,
and an `env_key` naming the child-only token. This flow differs from Codex's
experimental external-auth RPC; do not conflate their token formats or routes.

Use the stable LegionCode client name in Codex's initialize handshake. Models
are a catalog, not proof of account entitlement. Only a completed inference
request validates that model for the selected account/request.

ChatGPT plan usage has preview restrictions, including streaming/store=false
behavior and unsupported hosted tools. Codex's local shell/MCP tools have a
different execution path. Validate the pinned Codex configuration instead of
assuming every Responses feature or tool is available. Display usage links
when no reliable numeric usage endpoint exists for the selected route. Section
11 defines numeric usage provenance and freshness for both providers.

Initial scope is OSS/local use with eligible accounts. OpenAI's documentation
directs paid or remotely hosted apps to a separate interest process. Do not
transfer these credentials to LegionCode managed cloud or advertise cloud
subscription use as part of this local slice.

Possible later extension: authorize the same ChatGPT connection for LegionCode
Native Responses inference. That is a separate provider-route slice with its
own tool/history/limit conformance, not a requirement for hosting Codex.

## 7. Vertical implementation slices

Each slice includes a real caller → SDK → App Server → runtime → adapter →
durable projection/review path. UI packaging is separate; contract-only work
does not count as integration. Slice numbers identify scope, not serial order.

| Slice | Scope and acceptance |
| --- | --- |
| 048.L1 | Codex with existing supported login. Add only the delegated port/instance binding needed by this slice; prompt, approve edit/test, interrupt, capture immutable review, restart/replay. Prove native loop is not also executing. |
| 048.L2 | App-managed ChatGPT sign-in. Eligible user connects without an API key, grants plan usage, completes a real Codex Turn, restarts, refreshes, disconnects; denied consent and revoked credentials settle truthfully. |
| 048.L3 | Independent native OpenCode v2 slice in harness-opencode. Verify supported 2.x binary/client compatibility, reject v1/unknown, supervise an authenticated private server, verify server.info and subscribe to native events before prompting. Map supported permissions/questions, interruption, session attachment/recovery and review through the common contract without requiring L1/L4 completion. |
| 048.L4 | Claude Agent SDK through the same port; selected local subscription login after provider release gate, with explicit API-key route available independently. Map query events, permissions/questions, session continuation and abort. Prove billing source and no API-key precedence leak. |
| 048.L5 | Cursor through supported official SDK. Pin the dependency and verify account/auth and approval/resume coverage before enabling capabilities. |
| 048.L6 | Follow-on generic ACP extension: L6a installed custom command, L6b registry discovery/managed local installation, L6c curated cloud registry execution. One generic driver and shared host contract; preserve native built-ins and require each placement's own conformance. |
| 048.R | Optional pairing/relay and Web/mobile local control. Require Plan 047 Gate C plus enrollment, revocation, authorization, reconnect, origin/network and artifact-access proof. |

The native event feed is volatile. Establish its subscription before work,
monitor liveness, and reconcile session state after gaps instead of assuming
the stream replays missed events. Keep native server credentials distinct from
provider credentials, bind controls to the originating instance/generation,
and deduplicate restored messages against canonical records. Stop completion
requires observed execution settlement, not only a request acknowledgement.

At the start of each implementation PR, record CLI/SDK/protocol versions,
transport family, schema hash and resume-compatibility metadata. Persist them
with external bindings and reject incompatible reattachment; never retry a
prompt through a different transport. Follow the decision document's optional
capability gates and separate Stop acceptance from verified quiescence. Then
recheck current provider docs, trace active owners, and update the capability
ownership ledger for actual wiring changes. Do not alter that ledger to claim
this proposed design is already implemented.

L1/L2 (Codex), L3 (OpenCode v2) and L4 (Claude) are independent implementation
and release tracks. Any first working track may seed the shared contract.
Provider access gates only the affected authentication route; another driver
does not wait for it. L5/L6 and remote pairing remain later scope.

### 7.1 Initial scope and ACP follow-on, 2026-11-10

Prioritize LegionCode/BYOK, Codex, Claude Agent and OpenCode v2 in both execution
placements. 048/061 driver work, 057 Desktop delivery and 062 local environment
work proceed in parallel through their concrete dependencies; none requires
full Plan 061 completion. Use one owner per shared driver and one contract,
introduced with the first real consumer. Follow
[062 section 12](../062-LOCAL-EXECUTION-ENVIRONMENTS-SHELLS-WORKTREES-AND-INFERENCE-PLAN.md#12-implementation-slices-and-dependency-rules)
for lane ownership and shared-file coordination.

048.L6 implementation follows the built-in acceptance milestone for its target
placement and the proven shared host contract. It is not part of the current
built-in release gate and does not wait for unrelated 061 telemetry/UI closure.
Keep the existing L6 identifier, with these ordered subscopes:

| Subscope | Concrete result and acceptance |
| --- | --- |
| 048.L6a | Advanced settings can launch an already installed custom ACP executable with literal argv on Local. Negotiate the pinned supported protocol; expose agent-reported models/auth/capabilities; prove prompt, permissions/questions, Stop, immutable review and restart through canonical owners. No registry downloader required. |
| 048.L6b | Browse the official ACP registry and install an explicitly selected, pinned version on the local execution host. Validate platform, distribution metadata and available integrity evidence; own install/update/removal lifecycle and preserve agent-owned account data. Registry discovery is not a feature-parity guarantee. |
| 048.L6c | Run a curated set of registry agents inside managed Cloud using the same generic driver. Prove supported runtime dependencies/auth, reproducible installation, isolation, tenancy, resource limits, recovery and immutable review. Never forward arbitrary client executables or local credential directories to cloud. |

ACP is a transport/integration contract; the registry is discovery/distribution.
Neither supplies LegionCode lifecycle, storage or sandbox ownership. Keep one
generic ACP driver rather than agent-id branches; expose unsupported controls
truthfully. Native Codex/Claude/OpenCode integrations are not replaced or retried
through ACP. Local/cloud support is enabled only after that placement's proof.

## 8. Conformance and completion

Use existing focused contract/integration checks plus installed-app product proof:

- Live output and restart replay converge on the same ordered canonical records.
- Duplicate admission and reconnect cannot rerun edits or create another terminal.
- Approval deny/cancel/expiry and Stop settle pending tools and questions.
- Old process callbacks, rotated accounts and revoked workspace grants cannot act.
- Concurrent Threads/instances cannot share active approval, root, or auth state.
- Snapshot artifacts remain reviewable after host exit and later working-tree edits.
- Traversal/symlink escape and unauthorized shell/Git mutations fail at execution.
- Logs, renderer IPC, events, snapshots and command arguments expose no tokens.
- Missing binary, incompatible protocol, unavailable model, exhausted allowance,
  auth_required, killed child and resume failure yield typed actionable outcomes.
- Each harness has a real edit/test/review/restart proof; mocks supplement it.

Use Plan 057's existing package checks, boundary checks and installed-app test
harness. Extend existing assertions where needed; do not add test files or test
registrations, per AGENTS.md. No parallel event store, UI state machine, or
provider-error fallback.

Each driver completes independently when its real authenticated
edit/test/approval/Stop/review/restart path passes. Codex/Claude subscription
routes additionally require payer proof and their provider release gates;
OpenCode v2 proves its configured provider route without implying every
upstream subscription is available. L2 separately completes guided ChatGPT
connection. The combined initial integration scope includes all three drivers;
Cursor, generic ACP registry and remote pairing remain later scope.

## 9. Primary sources

T3 source links are pinned to the inspected commit:

- [Built-in registry](https://github.com/pingdotgg/t3code/blob/c9b21b28e2cebc4c9cbd80726e757df36309dea8/apps/server/src/provider/builtInDrivers.ts)
- [Codex adapter](https://github.com/pingdotgg/t3code/blob/c9b21b28e2cebc4c9cbd80726e757df36309dea8/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts)
- [Claude adapter](https://github.com/pingdotgg/t3code/blob/c9b21b28e2cebc4c9cbd80726e757df36309dea8/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts)
- [OpenCode adapter](https://github.com/pingdotgg/t3code/blob/c9b21b28e2cebc4c9cbd80726e757df36309dea8/apps/server/src/orchestration-v2/Adapters/OpenCodeAdapterV2.ts)
- [OpenCode generation selection](https://github.com/pingdotgg/t3code/blob/c9b21b28e2cebc4c9cbd80726e757df36309dea8/apps/server/src/provider/Drivers/OpenCodeDriver.ts)
- [OpenCode v2 adapter](https://github.com/pingdotgg/t3code/blob/c9b21b28e2cebc4c9cbd80726e757df36309dea8/apps/server/src/orchestration-v2/Adapters/OpenCode2AdapterV2.ts)
- [Cursor driver](https://github.com/pingdotgg/t3code/blob/c9b21b28e2cebc4c9cbd80726e757df36309dea8/apps/server/src/provider/Drivers/CursorDriver.ts)
- [ACP registry driver](https://github.com/pingdotgg/t3code/blob/c9b21b28e2cebc4c9cbd80726e757df36309dea8/apps/server/src/provider/Drivers/AcpRegistryDriver.ts)
- [ChatGPT authentication](https://github.com/pingdotgg/t3code/blob/c9b21b28e2cebc4c9cbd80726e757df36309dea8/apps/server/src/provider/CodexChatGptAuth.ts)
- [Managed Codex runtime](https://github.com/pingdotgg/t3code/blob/c9b21b28e2cebc4c9cbd80726e757df36309dea8/apps/server/src/provider/CodexManagedRuntime.ts)

Official protocol/product sources, verified on 2026-10-07:

- [ACP architecture](https://agentclientprotocol.com/get-started/architecture)
- [OpenCode ACP transport, authentication and session semantics](https://opencode.ai/v2/docs/cli/acp/)
- [Claude Agent SDK overview and authentication restrictions](https://code.claude.com/docs/en/agent-sdk/overview)
- [Codex app-server protocol](https://learn.chatgpt.com/docs/app-server)
- [ChatGPT plan-use overview and hosting scope](https://developers.openai.com/siwc/token-sharing-open-source)
- [ChatGPT registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Codex configuration for ChatGPT plan usage](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [OpenAI sign-in cookbook, published 2026-09-28](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt)

Inference-provider sources, verified on 2026-10-17:

- [Zen/Console models and use in other coding agents](https://opencode.ai/v2/docs/console/models/)
- [Go subscription, API access, client identity and session requirements](https://opencode.ai/v2/docs/console/go/)
- [Inference API and per-model wire protocols](https://opencode.ai/v2/docs/console/api/inference/)

## 10. Subscription research update on 2026-11-06

These current T3 sources were read from upstream `main` on this date; the
October commit above remains the pinned historical baseline. Pin the exact
upstream revision and dependency versions again when implementing.

| Inspected source | Finding and adoption |
| --- | --- |
| [T3 Codex setup](https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-codex.md) and [driver](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/provider/Drivers/CodexDriver.ts) | Managed ChatGPT connection and installed CLI login are distinct paths. Named instances carry account/configuration identity. Start with one explicitly selected account per instance; shared/shadow-home account switching is unnecessary for V1. |
| [T3 Claude setup](https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-claude.md) and [adapter](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts) | Uses Claude's login/configuration and the Agent SDK query interface. Separate configuration directories isolate accounts. Use `CLAUDE_CONFIG_DIR`, not a rewritten HOME. Configuration paths belong to the host, not the renderer. |
| [T3 usage registry](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/provider/builtInDrivers.ts), [Claude reader](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/provider/Drivers/claudeUsage.ts), [Codex reader](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/provider/Drivers/codexUsage.ts) | Driver-specific usage readers parse local transcript accounting. Transcript token totals are different from the provider's account-wide remaining allowance; do not infer quota percentages from them. |

T3's pattern to adopt is UI → host-side driver → official agent runtime. Local
execution still sends inference to the provider; it is not offline inference.
LegionCode retains its own canonical lifecycle and completed-turn artifacts.

Provider sources rechecked on 2026-11-06:

- [Claude plan and SDK help article](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan): subscription-backed SDK/third-party usage remains available; linked API credits are a different route.
- [Claude SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) and [quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart): third-party login/rate-limit offering still has an explicit prior-approval requirement. Resolve this scope with Anthropic before release.
- [Codex App Server](https://learn.chatgpt.com/docs/app-server): account, model, authentication and account-limit protocol surfaces; pin supported methods to the shipped binary.
- [ChatGPT plan sharing](https://developers.openai.com/siwc/token-sharing-open-source): OSS/local integration and separate paid/remote access process. The [self-hosted VM guide](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms) describes user-controlled hosting, not blanket permission for LegionCode managed cloud.

## 11. Local account and usage experience

Keep the existing provider/settings surface. Add a harness account connection
choice alongside API-key connections; an OAuth token is not an API key.

1. In Settings, choose Codex or Claude Agent, then select an existing local
   login or the supported guided connection. Show the provider account label,
   login state, executable/SDK health and where the connection can run.
2. Local CLI-owned authentication stays in the provider's protected store.
   App-managed secrets use the native vault. Store only opaque credential
   references and redacted metadata in SDK/UI state.
3. In a thread, select environment, agent, connection and model. Show a compact
   payer label such as `ChatGPT plan · Personal · Local` or
   `Claude plan · Work · Local`; do not infer billing from the model name.
4. Freeze the selection at Run Attempt admission. Changing the picker affects
   later attempts only. Changing harness/account may require an explicit new
   session; do not promise continuation across unrelated external homes.
5. Disconnect removes LegionCode's binding and app-owned secrets. Signing out
   of a CLI-owned account is a separate explicit action affecting that CLI.

Expose one shared read model in platform-protocol/SDK:

| Field | Rule |
| --- | --- |
| Connection identity | Opaque connection ID, agent kind, account label, environment availability, authentication generation and state |
| Billing source | `subscription`, `api_key`, or another explicitly configured route; never guessed from token cost |
| Quota windows | Provider-reported bucket ID/label, utilization, reset timestamp and scope, all nullable when absent |
| Freshness | `checkedAt`, source and `fresh`, `stale`, `unavailable`, or `unsupported` state; keep the age of cached observations |
| Turn usage | Measured input/output/cache tokens with Run Attempt provenance; estimated monetary equivalents must be labeled and are not subscription charges |

Codex CLI-managed sessions may use `account/rateLimits/read` and corresponding
updates when supported. App-managed plan-sharing configurations have different
auth semantics; probe support instead of assuming that endpoint works there.
Claude uses supported SDK limit notifications/status surfaces. No private
OAuth usage scraping is a dependency. If no supported numerical quota exists,
show that fact plus Manage usage, while retaining measured turn tokens.

Fetch on connection, Settings open and a relevant provider update, with bounded
per-account refresh and backoff. Do not poll every visible thread separately.
Quotas are account-wide and may include other apps; LegionCode turn usage is
only its own attributed activity. No fixed five-hour/weekly window assumptions.

When the harness reports a limit, render the window/reset when supplied.
If the external turn stays open, keep its lease and show waiting-for-limit
through the canonical activity projection; if it terminates, settle that
attempt explicitly and let the user continue after reset. Do not infer success,
spin indefinitely, replay a possibly executed prompt, or switch to paid API
usage. Stop remains available while waiting.

Exclude unrelated external CLI transcript imports from V1. Account-wide quota,
per-turn token accounting and LegionCode compute accounting are separate
concepts, even when displayed in one Usage view.

## 12. Parallel delivery and local acceptance

| Lane | First concrete deliverable | Waits for |
| --- | --- | --- |
| Shared harness, seeded by any first working driver | Real Turn through delegated execution, normalized append, terminal settlement and immutable review | Current canonical contracts; integration wires any missing in-path capability |
| 048 local integrations | Codex, Claude and OpenCode v2 independently: selected connection → prompt → approval → edit/test → Stop → review → restart | No 057/058 or other-driver completion gate; applicable provider auth requirements |
| 061 cloud integrations | Each of the three drivers: hosted connection → isolated harness → durable replay/review | Cloud acceptance and applicable provider auth requirements; no Mac or pairing dependency |
| 057 Mac product | Existing Electron shell, native access/vault, shared UI, local lifecycle/review and distributable beta | Its own LLD acceptance, with shared changes integrated as they merge |

One PR owns a touched shared contract at a time. Share the adapter implementation
through the fixed harness packages; host composition supplies paths, process
supervision, credential resolver and artifact/persistence ports. Do not add a
Desktop-only harness API or copy cloud adapters into Electron.

Integration acceptance includes a real local SDK/App Server caller for each
agent, payer verification, deny/Stop/restart, missing login/binary,
expired/revoked login, a reported usage limit, stale usage, a second account
remaining isolated, and canonical review after later filesystem edits. Local
mode requires no LegionCode account; closing or sleeping the Mac cannot be
advertised as continuing local work. Mac UI release adds clean-profile installed
proof under 057; it is not an integration entry gate. Cloud independence is
Plan 061's proof.

Planning baseline: this checkout is `main` at `e5f4e493` with unrelated user
changes. The deeper construction review inspected locally available
`origin/dev` at `ccaa54ca5240711c6d621ba39bc1465d74bc00b0` (2026-11-06), containing
`packages/sdk`, `packages/app-server`, `packages/client-ui` and `apps/desktop`.
Those directories are absent or empty in this main checkout; do not recreate
them here. Inspect the actual implementation base before coding. The mandated
`architecture/RUNTIME-ARCHITECTURE.md` is absent in both inspected refs; resolve
that reference and trace owners before architecture-sensitive implementation.
This planning revision fixes target construction without claiming an
implemented capability; update CAPABILITY-OWNERSHIP.md with actual wiring PRs.

## 13. Harness onboarding and runtime installation — 2026-11-10

This section adds setup and acceptance detail to L1/L2/L3/L4 and 061.C1/C2/C3/C6.
It does not claim implementation, change transport choices, enable a provider
route or expand the initial release to ACP registry agents. Preserve the L6
subscopes in section 7.1. Runtime installation and account authentication are
different responsibilities; neither alone establishes execution readiness.

### 13.1 Reference-product review and provenance

T3 Code was inspected at `4c924ff4e6d0828e0a5810336ec7d7827d752645`.
OpenCode upstream was inspected at `d4aeee551ebf554f37803b57618926c828a70b39`.
These are dated research revisions, not new LegionCode runtime pins. In
particular, revalidate current OpenCode behavior against the selected executable
and typed client before implementation; this review does not prove that the
existing 2.2.5 pin supports every current upstream feature.

| Verified reference behavior | LegionCode decision |
| --- | --- |
| T3's environment-specific add-provider wizard separates built-ins from ACP search. Configuration can exist before authentication. | Use one shared Add agent flow with separate runtime, account and readiness facts. Keep built-ins and later registry discovery distinct. |
| T3 managed ChatGPT setup installs Codex; manual setup can select an existing CLI/login. Managed installation verifies bytes/hash/version, stages a versioned directory and changes the active pointer atomically. | Offer explicit managed installation or an explicitly selected compatible existing runtime. Preserve external installation ownership; verify and stage before activation. |
| T3 registry tools install on the server host, including isolated versioned package runners. Checksums are verified when supplied, not promised for every registry entry. | L6 discovery is not installation or conformance. Record exact distribution and integrity evidence; apply reviewed distribution policy when evidence is insufficient. Do not imply every registry item is verified or cloud-supported. |
| T3 browser login opens on the client while auth/agent execution stays on the chosen host. Terminal login requires a host terminal. | Scope the auth attempt to host/instance/generation, render only safe instructions and wait for authoritative account confirmation. |
| T3 supports OpenCode v1/v2 compatibility and shared/shadow Codex homes. | Do not copy either policy: LegionCode remains native OpenCode v2-only and preserves explicit account/host isolation. |
| OpenCode's desktop, TUI and web UI use its server; provider/model setup belongs to that harness. | Supervise the selected private native server through harness-opencode. Do not embed its public UI or silently attach to a user's shared service. OpenCode plus an Anthropic model remains the OpenCode loop. |
| Current OpenCode stores accounts in its server SQLite database; saved accounts can override environment credentials and the newest login becomes active. Legacy auth.json is migration input. | Verify the selected account/payer instead of trusting a supplied environment key. Use isolated provider-owned storage through typed external references; never copy a real provider home/database, directly mutate its credential tables or silently import legacy auth. |
| Current OpenCode native permissions are not OS confinement. Reject can close all pending permissions in a session; Always persists project-scoped rules. | Enforce restrictions at the real host boundary. Reconcile the exact native rejection cascade; never relabel project-wide permission as matching-in-chat or offer a scope the product cannot enforce. |
| OpenCode update notification, installed binary and running server version are separate facts. | Activation uses an explicit new process generation; no update mutates an admitted attempt or implies supported resume. |

Pinned evidence:

- T3 [setup wizard](https://github.com/pingdotgg/t3code/blob/4c924ff4e6d0828e0a5810336ec7d7827d752645/apps/web/src/components/settings/AddProviderInstanceDialog.tsx), [managed Codex installation](https://github.com/pingdotgg/t3code/blob/4c924ff4e6d0828e0a5810336ec7d7827d752645/apps/server/src/provider/CodexInstallation.ts) and [installation ownership](https://github.com/pingdotgg/t3code/blob/4c924ff4e6d0828e0a5810336ec7d7827d752645/apps/server/src/provider/providerInstallation.ts).
- T3 [Codex accounts](https://github.com/pingdotgg/t3code/blob/4c924ff4e6d0828e0a5810336ec7d7827d752645/docs/user/providers-codex.md), [Claude setup](https://github.com/pingdotgg/t3code/blob/4c924ff4e6d0828e0a5810336ec7d7827d752645/docs/user/providers-claude.md), [OpenCode setup](https://github.com/pingdotgg/t3code/blob/4c924ff4e6d0828e0a5810336ec7d7827d752645/docs/user/providers-opencode.md) and [ACP registry/auth/distribution](https://github.com/pingdotgg/t3code/blob/4c924ff4e6d0828e0a5810336ec7d7827d752645/docs/user/providers-acp.md).
- OpenCode [installation](https://github.com/anomalyco/opencode/blob/d4aeee551ebf554f37803b57618926c828a70b39/services/site/src/docs/content/index.mdx), [provider accounts and storage precedence](https://github.com/anomalyco/opencode/blob/d4aeee551ebf554f37803b57618926c828a70b39/services/site/src/docs/content/cli/providers.mdx), [server/web clients](https://github.com/anomalyco/opencode/blob/d4aeee551ebf554f37803b57618926c828a70b39/services/site/src/docs/content/cli/web.mdx), [updates/configuration](https://github.com/anomalyco/opencode/blob/d4aeee551ebf554f37803b57618926c828a70b39/services/site/src/docs/content/config.mdx), [permission scope](https://github.com/anomalyco/opencode/blob/d4aeee551ebf554f37803b57618926c828a70b39/services/site/src/docs/content/permissions.mdx) and [ACP interface](https://github.com/anomalyco/opencode/blob/d4aeee551ebf554f37803b57618926c828a70b39/services/site/src/docs/content/cli/acp.mdx).

### 13.1.1 Continuing upstream review — 2026-11-11

Recheck both upstream projects at integration milestones, before changing any
runtime/client/schema pin and before merging affected PRs. Record exact revisions,
read relevant source changes and repeat affected existing checks; do not silently
upgrade, copy another product's authority or infer release acceptance.

The pre-merge review for PR #813 inspected T3 Code
`871b00907d0bcf2705224de6c6e90de925c7cbb9` and OpenCode development
`d22bc1d1b6b57e6f9b30c242c03bf5eaa00e127f`. LegionCode's reviewed OpenCode
executable remains pinned to 2.2.5. These newer research revisions do not change
that runtime/client/schema compatibility claim.

- T3 [native todo projection](https://github.com/pingdotgg/t3code/commit/71a1c49b75a209284ea24617e6a4b0cc339390e7)
  projects recognized successful OpenCode `todowrite` metadata into checklists,
  including reconnect recovery, status changes, cancellations and clears. If
  adopted, translate through existing canonical workflow contracts and preserve
  failed/unrecognized tool results; do not create a provider-owned product store
  or advertise planning capability before the real consumer/replay is wired.
- OpenCode [PTY protocol8](https://github.com/anomalyco/opencode/commit/d22bc1d1b6b57e6f9b30c242c03bf5eaa00e127f)
  changes persistent process records and the PTY dependency to 0.5.0. A future
  runtime upgrade must reprove daemon/server compatibility, background writers,
  Stop and restart ownership; native process exit or a foreground final remains
  insufficient proof of workspace quiescence.
- T3 [Codex image-generation rows](https://github.com/pingdotgg/t3code/commit/5be6bc99c234b0db92ffb0b3ebd8746fd579112b)
  preserve tool identity across failure/cancellation and keep an image reply from
  replacing its tool row. This is a translation/presentation consideration,
  not an additional LegionCode feature or capability claim in this checkpoint.

The subsequent pre-merge review for workspace settings PR #817 inspected T3
`d756fed7aaac06134bc68cbe0047e6f14b0e9aa2` and OpenCode
`95aa28e5c8b72007c5b4a7cbe59eadb3e8b1a863`. T3's
[cancelled-run handoff change](https://github.com/pingdotgg/t3code/commit/d756fed7aaac06134bc68cbe0047e6f14b0e9aa2)
adds started cancelled runs to terminal handoff candidates, excluding work that
never started. LegionCode does not infer physical closure from cancelled status
or copy this product handoff policy: an admitted attempt keeps its frozen
account/environment/runtime binding, Stop acceptance remains separate from
quiescence, and there is no silent cross-environment or payer migration. OpenCode's
[sidebar change](https://github.com/anomalyco/opencode/commit/95aa28e5c8b72007c5b4a7cbe59eadb3e8b1a863)
affects session UI presentation, with no native protocol, installation or account
authority change. Runtime pins remain unchanged.

The replay/steering integration checkpoint also reviewed these exact source
changes, without changing runtime pins or claiming provider acceptance:

- T3 `dd0737d3e2029da533f1c430a10869a060396b63`
  [scopes agent sign-in approval to a linked environment and browser-held access](https://github.com/pingdotgg/t3code/commit/dd0737d3e2029da533f1c430a10869a060396b63).
  LegionCode keeps local/cloud authorization explicit; a convenient browser
  approval UI does not authorize copying credentials or imply hosted subscription
  access approval.
- OpenCode `993a2808879853210a5e8e80eabfc55c4299f30e`
  [lets parked Claude tool calls finish across instruction/tool changes](https://github.com/anomalyco/opencode/commit/993a2808879853210a5e8e80eabfc55c4299f30e),
  explicitly fails calls to removed tools, and starts a new process after abort
  when the launch binding changed. Adapt the lifetime lesson to LegionCode's
  frozen attempts: mutable settings cannot silently restart or rebind an active
  attempt, and pending replies stay bound to their originating generation.
- The actual Codex 0.167.0 source, revision
  `086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a`, supports
  [client user-message correlation](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L939).
  A steer RPC queues input; the later completed user-message notification follows
  accepted history recording. The driver must correlate the original input and
  admitted native turn through the existing observation journal before emitting
  an application receipt. That notification does not expose model-step or
  context-revision values. A truthful delegated receipt contract and its real
  driver consumer are required; do not invent those fields or equate RPC ACK
  with application. This is an identified implementation gap, not completed
  steering acceptance.

### 13.1.2 Upstream checkpoint — 2026-11-14

The checked upstream tips are T3 Code
`c83e78fe073db40b17cd6d478a88fe575125bb96` and OpenCode
`f91b88efac039856f284979984ac43cd93bce8f5`. This checkpoint inspected the relevant
runtime-update and account-connection changes below; it is not a new runtime pin
or a claim that every intervening upstream feature is supported.

T3's merged [OpenCode update verification](https://github.com/pingdotgg/t3code/pull/22839),
merge `b5256ad09c0553347a6ddfd2d30de9b9c12c79d5`, distinguishes an installed CLI
from a still-running older server. LegionCode must likewise report installation
and running runtime versions separately, validate the admitted pinned server and
typed client, and require safe explicit restart when an update cannot apply yet.
It must not silently replace an active attempt's runtime, terminate user work,
attach to an arbitrary server URL or infer process settlement from a successful
installer. LegionCode retains its own private authenticated OpenCode v2 server.

OpenCode's [connection-dialog change](https://github.com/anomalyco/opencode/commit/f91b88efac039856f284979984ac43cd93bce8f5)
separates provider/account/sign-in navigation. Its regression cases retain
coverage for late asynchronous results when navigating back. Adapt the UI lesson through shared
client-ui and existing SDK/App Server operations: pending, cancelled and completed
steps remain distinct, and stale completion cannot navigate or select a different
account. UI cancellation does not itself prove credential revocation or execution
quiescence; existing vault generation/CAS and originating request identity remain
authoritative. This upstream UI provides no LegionCode hosted subscription approval.
Codex remains pinned to 0.167.0 and OpenCode to 2.2.5; their existing acceptance
gates remain outstanding.

### 13.2 Shared user flow

Settings → Agents → Add agent is shared client-ui using the existing SDK/App
Server operations. It is a presentation flow, not a new credential service or
parallel public API. Use these steps:

1. **Environment:** This Mac or a specific hosted environment. State where files,
   processes, runtime installation and credentials live. Cloud needs no local
   runtime. Changing environments does not transfer credentials or active work.
2. **Harness:** choose Codex, Claude Agent or OpenCode v2. Keep LegionCode
   Native/BYOK a separate execution choice. A provider key must not choose the
   harness implicitly; OpenCode's supported provider choice comes after it.
3. **Runtime:** show exact detected/managed version, compatibility, installation
   owner and actionable health. Offer Install runtime when supported or an
   advanced existing-executable choice validated by the host. Do not ask users
   to edit PATH, run global npm commands or paste shell strings as the default UX.
4. **Account:** choose an existing provider-owned login or a supported guided
   route; show its account label and actual billing route. Keep API keys,
   app-managed OAuth and external credential references typed and distinct.
   Preserve provider approval gates even when a competitor exposes a route.
5. **Verify:** read runtime/account/model/capability state back from the selected
   host. Configuration saved, runtime installed, account connected and execution
   ready are separate facts with freshness and a specific failure reason.
6. **Use:** the composer selects environment → harness instance/account → model
   from that instance's advertised catalog. Freeze the full binding per attempt.

Connection cards show label, environment, runtime health/version, account/auth
state, billing route, model freshness and unavailable capabilities. Offer the
applicable Install, Connect, Reconnect, Update or Remove action. Quota may remain
unknown on an otherwise usable connection; show it separately from measured run
activity and cloud compute. Do not derive Ready from installation, UI selection,
stored configuration, model discovery alone or an auth callback alone.

The saved-API-key-first setup in the reviewed implementation checkpoint does
not fulfill this flow. Migrate every mounted setup/selection consumer through
the canonical owners; do not declare onboarding complete because a new wizard
renders or a setup request returns an instance ID.

### 13.3 Runtime, account and process ownership

Host-side installation services own executable resolution, platform checks,
integrity, version probing, staging and removal. Drivers own native protocol,
account and usage translation; harness-core owns configured instances/process
generations. Existing encrypted custody owns app-managed credentials; provider
stores remain provider-owned behind typed references. SDK/client-ui receive
redacted state and opaque identifiers. Introduce any missing operation with its
first actual consumer through the fixed owners, not an empty installer package.

For managed local runtimes, stage an explicitly selected pinned distribution in
an app-owned versioned directory, validate archive paths/integrity and executable
compatibility, then atomically activate. Interrupted/corrupt installs must not
replace a working version. Never overwrite a user's CLI, modify shell profiles,
repurpose OS HOME or make a global package manager an implicit dependency.
Claude's supported configuration directory and each provider's own documented
configuration controls do not replace real isolation or the OS credential store.

For Cloud, stage the frozen runtime graph during approved environment/image
distribution and retain the current sandbox backend and image-size gate. The
renderer/browser neither installs executables nor chooses arbitrary server URLs.
Provider authorization and actual tenant/execution isolation remain required.

Active attempts and sign-in/install operations retain ownership of their runtime
version and generation. Stage upgrades separately; refuse deletion while those
owners or unknown cleanup remain. Do not blindly restart or migrate a provider
session after installing an update. Validate persisted transport/resume
compatibility on restart and report unsupported recovery without resending an
ambiguously accepted prompt. Uninstalling app-owned binaries, removing an
instance, disconnecting app-managed credentials and signing out of a shared CLI
are separate explicit actions; preserve workspace/history/artifacts and do not
delete provider-owned account data as a side effect.

Auth runs on the selected host even when its browser page opens on the client.
Handle URL/loopback/device/terminal methods only when supported, bind callbacks
to the original instance/auth attempt, and fence cancellation, expiry, account
switches and stale completion. Wait for verified account identity and refreshed
models; never accept a redirected page alone as success. Host-local private
terminal responses and tokens must not enter chat, events, snapshots or logs.
An environment credential cannot override a different saved OpenCode account
by assumption. Verify actual selected-account precedence on the pinned runtime;
logout must not claim removal of an environment credential that still exists.

### 13.4 Required onboarding and lifecycle proof

Reuse and strengthen existing checks; add no test files or registrations.
Each driver/placement records exact runtime/client/schema and account-route
evidence in its implementation PR. These are product acceptance requirements:

| Scenario | Required result |
| --- | --- |
| Clean installed Mac without runtimes | Explicit install → verified runtime → supported account connection → real edit/test/approval/Stop → immutable review → restart/replay. Check actual Keychain, packaging and OS behavior locally. |
| Web and Mac cloud | No Mac CLI requirement; both select the same hosted instance/Thread and replay the same approvals/history/review. Client loss does not end execution. |
| Wrong binary/platform/version or corrupt/interrupted install | Actionable setup failure; no v1, ambient-binary or transport fallback; preserve the prior verified version. |
| Auth cancel/expiry/restart and environment switch | Stale callback cannot bind another host/account; no prompt is sent during setup; retry follows the supported auth semantics. |
| Saved account A plus selected environment credential B | Verify the actual payer or reject; no hidden saved-account precedence or silent API-key/subscription switch. |
| Account change/update/removal during a Turn | Freeze existing authority/version, reject stale replies and retain process/lease ownership until safe settlement. No forced runtime migration. |
| Multiple native OpenCode approvals and broader Always scope | Settle the actual rejection cascade and prohibit a misleading chat-scoped label for project-wide permission. Unknown closure stays unknown. |
| Out-of-root filesystem/shell/network/control-endpoint access | Enforced boundary blocks it independently of prompt instructions and native approval strings. |
| Authenticated but stale/missing models/quota | Refresh bounded host observations; display honest freshness/unknown telemetry without inventing readiness, quota or payer. |

L6 later adds generic ACP custom-command/registry proof through the same owners.
Registry discovery, agent authentication, native permission defaults and
OpenCode's own client-pairing link are not substitutes for LegionCode's
authorization, confinement, durable lifecycle or immutable review acceptance.
