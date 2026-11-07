# 061 — Independent Cloud Harness Integration

Date: 2026-11-06 (Asia/Kolkata)
Status: Planned; research and design only. No code, provider connection, secret
transfer, external account change or deployment performed by this plan.

Local counterpart: [Plan 048](048-PAIRED-LOCAL-HOST-AND-MULTI-HARNESS-ADOPTION-PLAN.md)
and [LLD 048](LLD/048-local-harness-integration-and-chatgpt-plan-usage.md).
Mac delivery remains owned by Plan 057 and its existing LLD.

Fixed construction authority:
[Harness integration construction](../../../architecture/HARNESS-INTEGRATION.md).
The deep T3 Code/Codex OSS/OpenCode v2 review pins source revisions and defines
the final directory map. It supersedes this plan's earlier execution-engine
adapter placement: drivers start in shared harness packages, with a private
cloud bridge, reliable observation delivery and non-root harness execution.

Transport authority:
[ACP versus native decision](../../../architecture/HARNESS-TRANSPORT-DECISION.md).
It compares current native APIs, ACP v1/draft v2 and all three ACP integrations.
Use one native driver per harness across placements: Codex app-server/stdio,
official Claude Agent SDK streaming query and OpenCode v2 private native
server/typed client/SSE. ACP remains a valid independent extension path behind
the shared contract; it is not a cloud restriction or a recovery fallback.

## 1. Product decision

Let a user select Codex, Claude Agent or OpenCode v2, connect its supported
account/provider route, and run that agent inside the user's isolated
LegionCode cloud workspace. The browser can disconnect and the Mac can sleep
while cloud work continues. Subscription allowance pays for eligible inference;
LegionCode compute/storage remains separately attributed and limited.

All three harnesses are initial scope and independently implementable and
releasable. Plan 057, Plan 058, the Native golden loop and another driver's
completion are not prerequisites. Each slice implements any missing in-path
wiring through existing canonical services and proves its own runtime contract.

Local harness integration, cloud harness integration and Mac delivery
are parallel work lanes. Reuse one delegated-harness adapter contract, one SDK,
one runtime lifecycle, one approval model and one artifact/review path. Cloud
does not require full Plan 057 completion, a running Mac or local-host pairing.
This is managed-cloud hosting, distinct from Plans 032/048's local-host relay.

Web and Mac cloud open the same hosted environments, Threads, approvals and
review. Neither client owns the cloud process. Mac local selects its loopback
App Server and Mac-owned workspace/credentials while reusing the same driver
packages. Switching the environment picker does not move active work or copy
credentials. The full matrix requires separate Web/cloud, Mac/cloud and
Mac/local acceptance for each independently released driver.

The first release supports personal connections and an explicit selection of
one account per Run Attempt. Multi-account rotation, shared organization
subscriptions, automatic payer fallback and cross-harness conversation import
are outside V1. Existing BYOK remains an explicit separate choice.

## 2. What the reference products actually expose

Public documentation inspected on 2026-11-06. Their internal implementation is
only established where the cited documentation describes it.

| Reference | Observed behavior | LegionCode adoption |
| --- | --- | --- |
| [T3 Code Codex](https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-codex.md), [Claude](https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-claude.md), [Claude adapter](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts) | Codex app-server and Claude Agent SDK integrations, host-side logins and named instances. Claude accounts use separate config directories. | Reuse this local adapter pattern in cloud composition; credentials and execution placement remain distinct. Detailed local research lives in LLD 048. |
| [Hoplite](https://hoplite.sh/), [execution](https://hoplite.sh/docs), [routing](https://hoplite.sh/docs/agent/models), [billing](https://hoplite.sh/docs/workspace/billing) | Documents personal Claude token connection, Claude credentials outside the thread sandbox, and automatic eligible ChatGPT routing. Cloud threads retain distinct workspaces across follow-ups. Usage attributes the actual payer separately from compute. | Make payer visible, preserve workspace continuity and show compute independently. Do not adopt its fallback chains or assume its external credential/inference architecture is the same as hosting the whole harness in a sandbox. |
| [Replicas Codex](https://docs.replicas.dev/features/coding-agents/codex), [Claude](https://docs.replicas.dev/features/coding-agents/claude-code), [credentials](https://docs.replicas.dev/admin/credentials) | Documents CLI-assisted OAuth connection for each subscription, per-workspace isolated VMs, personal/org credential scopes and Usage with reported subscription windows. | Offer guided connection and explicit scope; begin with personal credentials. Do not copy org sharing, credential precedence/fallback chains or exact token lifetimes. |
| [Amp Claude mode](https://ampcode.com/docs/the-dial), [announcement](https://ampcode.com/news/use-your-claude-plan) | Claude mode uses the Agent SDK on Amp's servers, linked in account routing, and works with cloud orbs or user runners. Orb charges remain separate from the plan. | Show agent mode, subscription connection and execution environment independently. Run the whole supported harness; do not pass subscription tokens to LegionCode Native as ordinary API keys. |

These are product precedents. They do not establish provider approval for
LegionCode or prove those products use identical credential architectures.

## 3. Provider access and release gates

| Route | Verified documentation | Required release evidence |
| --- | --- | --- |
| OpenCode v2 native server/client | [T3 native v2 integration](https://github.com/pingdotgg/t3code/blob/10f88f34edca46ee529db09598476715f32d507b/packages/provider-opencode/src/server/v2/OpenCode2Server.ts) owns a supervised/authenticated server and typed client. | Pin a supported 2.x executable and compatible native client/protocol. Prove the selected provider's supported cloud auth/billing route. Other drivers' approval does not gate independent routes or become bypassable through OpenCode. |
| Codex with CLI-managed ChatGPT authentication | [Codex App Server](https://learn.chatgpt.com/docs/app-server) supports its account/session protocol. Replicas documents hosted OAuth connection. | Confirm the supported remote login flow, credential custody and managed service scope for LegionCode with current provider requirements; pin the binary and verify a real subscription-backed Turn. A working local CLI token is insufficient cloud-release evidence. |
| Codex with app-managed ChatGPT plan sharing | [OpenAI plan-sharing overview](https://developers.openai.com/siwc/token-sharing-open-source) covers OSS/local apps and directs paid/remote apps to an interest process. [Codex configuration](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) defines its distinct Responses route. | Obtain access covering the paid/remote LegionCode service and use its documented client registration, scopes, callbacks and refresh flow. Do not transplant local-preview credentials into managed cloud. |
| Claude Agent SDK with Claude subscription | [Claude help](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) says SDK/third-party usage still draws from subscriptions. [SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) and [quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart) still restrict third-party login/rate-limit offerings without prior approval. | Obtain documented clarification/approval for LegionCode's hosted offering and connection method. Record the applicable authentication/SDK version and prove the selected plan is charged. Do not interpret the help article alone as removal of the product approval requirement. |

Provider access is a release dependency, not a reason to serialize Mac and cloud
engineering. The adapter, sandbox supervision and canonical integration can be
proved using an explicitly selected supported API key while access is pending.
That proof does not complete or advertise subscription support. No provider
outreach or access application is sent as part of this planning task.

## 4. Canonical execution path and ownership

```text
Web or Desktop → SDK → existing App Server / Brain hosted composition
                           |
             admission + selected environment + frozen account binding
                           |
               existing secure execution boundary
                           |
          delegated-harness supervisor in isolated cloud environment
                 /                 |                   \
         Codex app-server    Claude Agent SDK    OpenCode v2 server/client
                 \                 |                   /
             validated facts → runtime canonical append
                           |
          existing durable replay / live continuation / artifacts / Git
```

Node subprocesses run in the execution environment, not inside a Cloudflare
Worker request. The supervisor and harness are part of the same run lease and
restart/fencing contract. Keep the existing Cloudflare sandbox backend unless
a measured missing capability requires a separately reviewed backend change.
Replicas' VM design is a reference, not a dependency on a new VM vendor.

| Responsibility | Canonical owner | Concrete change |
| --- | --- | --- |
| Agent/connection/account-status schemas | platform-protocol, consumed through SDK | Extend existing schemas with discriminated auth and usage metadata |
| Delegated execution contract | runtime-kernel narrow port under Plan 048 | First real local or cloud consumer introduces it; share one implementation contract |
| External RPC/SDK translation | harness-codex, harness-claude and harness-opencode, composed through harness-core | Same packages used locally/in cloud; Codex RPC, Claude SDK and OpenCode native v2 client/events, matching T3; no parallel native loop |
| Cloud process/root/environment isolation | secure-agent-api execution backend and leases | Host supervisor, pinned runtimes, validated root, bounded process resources and generation fencing |
| Credential custody and refresh | Brain provider connection services and persistence credential boundary | Extend current encrypted secret support with typed subscription records and concurrency-safe refresh |
| Admission, terminal settlement and requests | existing runtime lifecycle and permission owners | Normalize external observations into the one durable append path |
| Review and Git | existing snapshot/artifact/Git owners | Capture immutable per-turn evidence; external provider transcript is not review truth |
| Usage presentation | SDK read model and shared client-ui | Redacted account/limit snapshots; no client-side quota authority |
| Cloud compute accounting | Plan 052 service/ledger and existing admission limits | Attribute compute to Run Attempt and credential owner without turning inference quota into compute allowance |

Current credential persistence exposes an API-key-shaped contract and a
user/provider uniqueness constraint. Do not hide OAuth JSON inside its `apiKey`
field. Introduce a typed secret payload and opaque connection identity at that
existing boundary, migrating its API-key consumers in the same slice. Preserve
encryption/key versioning and user/workspace authorization. Full multiple-account
selection is later; do not migrate to a broad organization credential system.

Implementation targets the actual reviewed `dev` integration base. The deeper
construction review inspected locally available `origin/dev` at
`ccaa54ca5240711c6d621ba39bc1465d74bc00b0`, dated 2026-11-06; it is not a fresh
remote audit. Main is older and has unrelated dirty changes. Inspect active producers
and consumers before coding. AGENTS.md's RUNTIME-ARCHITECTURE.md reference is
missing in both inspected refs; resolve that reference and trace ownership
before changing architecture-sensitive production paths. Planning does not
change CAPABILITY-OWNERSHIP.md's implemented-state ledger.

## 5. Connection and credential lifecycle

1. Settings → Agents/Connections → choose Codex, Claude Agent or OpenCode v2 →
   choose the supported provider/subscription connection. Explain cloud use
   and separate compute billing at connection.
   Authenticate through the provider's supported browser/device flow.
2. Begin with the provider-supported hosted callback flow. If loopback is the
   only supported method, use a small CLI connection helper that authenticates
   on the user's machine and transfers only the selected authorized connection
   over a one-time, short-lived, user-bound exchange. Ship this only after its
   provider gate passes. Do not request a whole config-directory upload or a
   pasted token in chat. Mac installation is not required.
3. Bind authorization state, PKCE/nonce where supported, target user/workspace,
   exact provider client/host identity and intended callback. Expire abandoned
   handshakes; reject replay, session substitution and cross-user attachment.
4. Validate identity/scopes using the provider's supported mechanism. Encrypt
   credentials at the existing persistence boundary. SDK/UI receive account
   labels, allowed placement, connection state and opaque IDs only.
5. Resolve credentials after tenant authorization and admission. Give the
   selected harness only the credentials needed for its attempt. Keep long-lived
   refresh credentials outside repository files, generic shell variables,
   browser state, event payloads, artifacts, logs and process arguments.
6. Use supported token injection or an isolated host-owned auth location,
   excluded from workspace snapshots. Do not claim an auth file or environment
   variable is secret from arbitrary commands running as the same OS identity.
   Prove the process boundary or document the trusted single-owner environment
   limitation; personal credentials must not enter team-shared execution.
7. Serialize refresh per connection with a durable generation/CAS check, not
   just an in-memory mutex. A rotated token replaces its predecessor once;
   concurrent runs cannot overwrite newer refresh state. Fence old processes.
8. Disconnect prevents new admissions, cancels active attempts using that
   connection, removes runtime material and revokes provider authorization where
   supported. Never resurrect a disconnected record after a late refresh.

Local and cloud connections are explicit separate authorizations. Connecting
a local CLI account does not publish its credentials, history or code. Personal
subscription use is not automatically available to another workspace member.

### OpenCode v2 host integration

Launch the pinned native v2 server with isolated instance configuration and an
ephemeral server password. Use the compatible typed client; verify server.info
readiness and subscribe to native events before sending prompts. Complete
supported provider login on that host and bind sessions to the resolved root.
Keep server auth separate from inference credentials. Monitor stream liveness
and reconcile native session state after a gap; do not assume SSE replay or
resend an ambiguous prompt. Map native permission/question and stop/settlement
semantics into canonical records. Session usage does not imply remaining
account allowance. Provider inference and LegionCode compute remain separate.

## 6. Runtime, approvals and recovery

Freeze environment, workspace, harness version, external session binding,
connection ID/auth generation, billing source, model and policy per attempt.
Canonical Thread/Turn/Run Attempt IDs remain distinct from provider IDs.
The host validates the root, acquires the checkout lease and captures start
evidence before sending the prompt. One writer owns a checkout at a time.

Translate supported provider tools, approval requests, questions and output into
typed canonical events before live delivery. External tools execute in that
harness; they do not magically pass through LegionCode's native tool executor.
Configure enforceable permissions at the real subprocess/sandbox boundary.
Keep canonical Git operations in Git services. If the selected harness's shell
cannot enforce the required workspace/Git restrictions, restrict that capability
or keep the mutating adapter unreleased; prompt instructions are insufficient.

Stop aborts the external execution and waits for quiescence before final
snapshot/lease release. Duplicate terminal callbacks, stale process events and
retried admissions cannot duplicate actions or settlements. A closed socket or
zero process exit is not, by itself, a successful completed Turn.

Browser loss only drops a subscriber. Cloud leases, process supervision and
durable events continue independently. After a process/sandbox restart, load
the persisted external-session binding and verify supported resume before
continuing. Persist required provider session state separately from credential
material. Never resend an ambiguous prior prompt on reconnection. If provider
resume is unsupported, settle explicitly and offer a new attempt.

Preserve the existing workspace continuity and immutable artifact owners across
sleep/wake. Capacity, storage and run duration remain governed by the existing
cloud policies; a subscription does not grant unlimited cloud execution.

## 7. User selection, usage and limits

Use the same account/usage projection as LLD 048 section 11. Settings shows
connection state, environment availability, selected account, reported allowance
windows/reset time, freshness, Manage usage, reconnect and disconnect.
The composer shows environment → agent → connection → model and a compact
subscription payer label. Unsupported combinations are unavailable with a
specific reason. The transcript and review presentation stay shared.

Keep three independent measures visible:

- Provider subscription quota: authoritative account-wide observations, with
  nullable windows/percent/reset values and a checked time.
- LegionCode model activity: measured tokens for its own runs, attributed to
  the selected connection; estimated API equivalents are not plan charges.
- LegionCode compute: independently metered duration/allowance and charges
  from Plan 052. Plan-backed inference does not make cloud compute free.

Use documented/supported provider telemetry. Codex CLI auth may expose
account/rate-limit RPC; the app-managed Responses configuration may not.
Claude exposes SDK limit notifications where available. Missing data displays
unavailable/unsupported with Manage usage, not a fabricated zero or 100%.
No private usage endpoint, cookie scraping or fixed quota-window assumptions.
The current Claude ACP bridge uses a deliberately unstable SDK method for its
structured `/usage` presentation; neither choosing ACP nor native makes that
a stable quota contract. Gate experimental reads separately. OpenCode's
prompt/session cost and tokens are not account-wide remaining subscription
allowance; distinguish child usage and avoid double counting.

Quota refresh is bounded and deduplicated per connection. A snapshot can be
stale and is advisory for admission; the provider can still reject a request.
On a known exhausted window, avoid futile new work. Preserve unknown telemetry
as unknown and report any actual provider limit truthfully.

If an active harness pauses until reset, show a canonical waiting reason and
Stop; cap cloud waiting time under the duration/compute policy. If it ends,
settle the attempt and retain partial work. Continuation after reset is explicit
unless a still-live provider turn resumes under the selected policy. Never
rotate accounts, switch harnesses or charge a paid API key automatically.

## 8. Delivery slices and parallel dependencies

Each implementation slice has a real caller → SDK → hosted boundary → runtime
→ adapter → durable review path. Use existing UI where ready; full shared-UI
extraction and Mac packaging are separate. Fold needed schema/persistence migration
into that slice. Research and provider applications can proceed independently;
there is no contract-only implementation milestone.

| Slice | Concrete deliverable and exit proof | Dependency |
| --- | --- | --- |
| 061.C0 | Trace current owners/consumers; pin CLI/SDK/protocol, schema hash, transport family and resume compatibility; gate optional/experimental capabilities; document provider-access evidence and choose the first executable cloud path in its scoped PR | Current code and provider docs plus the ACP/native decision; no Mac dependency |
| 061.C1 | Independent Codex cloud Turn from harness-codex/core via the delegated port, non-root supervisor and reliable bridge: selected connection, approval, edit/test, Stop, replay and immutable review. API-key-only access is adapter proof, not subscription completion | Reuses or seeds shared contract; wires missing in-path cloud capabilities; no other-driver/057/058 predecessor |
| 061.C2 | Codex subscription connection through supported cloud flow, encrypted custody/refresh/revoke, payer label and real subscription-backed edit/test/review | Codex provider gate and C1; no 057.8 gate |
| 061.C3 | Independent Claude SDK cloud slice using the same contract, connection and supported permissions/abort/resume; plan-backed proof when authorized | Reuses or seeds shared contract; Claude provider gate affects its auth route only; no Codex/OpenCode/057/058 predecessor |
| 061.C6 | Independent OpenCode native v2 slice in harness-opencode: pinned binary/client, authenticated server readiness, native event subscription before prompt, supported provider connection, permission/question, Stop, reconciliation and immutable review | Reuses or seeds shared contract; configured-provider access requirements; no Codex/Claude/057/058 predecessor |
| 061.C4 | Shared Usage UI, missing/stale telemetry, quota exhaustion, explicit continuation and separate compute attribution | Each enabled provider's supported observations and Plan 052 compute accounting |
| 061.C5 | Per-driver browser-disconnect/laptop-sleep proof, process recovery, user isolation, refresh/revoke, concurrent threads and canonical replay/review | Run for each ready driver independently; another driver's incomplete slice does not block release |

Slice identifiers preserve existing references; C6 is not scheduled after C5.
Codex C1/C2, Claude C3 and OpenCode C6 can proceed independently in either
placement. Any first merged real consumer seeds the shared port. Coordinate
shared-file merge conflicts without serializing the whole integration program.
Each integration wires and proves its missing capabilities. Mac packaging,
signing and beta closure remain 057 work; Web extraction remains 058 work.

Do not start organization sharing, fallback chains, harnesses beyond these three,
mobile, cross-environment handoff or a second public SDK in this release.

## 9. Acceptance and completion

Reuse existing checks and strengthen existing assertions; add no test files or
registrations. Run relevant package type checks, boundary/lint checks, existing
runtime/lifecycle/provider/persistence suites and cloud conformance/golden path
gates on the implementation base. Keep exact versions and real acceptance
evidence in the PR. Planning-only changes require document/link consistency.

For each provider, prove:

- A supported account/provider connection completes a real edit/test/review
  path with its payer visible. Codex/Claude subscription routes additionally
  prove actual plan usage without incidental API-key precedence.
- Browser refresh/reconnect replays the same ordered records and artifacts.
  Closing the laptop does not stop cloud work.
- Denied approval, Stop, expired/revoked login, actual reported rate limits,
  missing usage telemetry, process death and unsupported resume yield truthful
  outcomes and release leases according to policy.
- Two users/threads cannot share credentials, roots, approvals, external
  session bindings or refresh results. Revocation races cannot revive access.
- Tokens/config files are absent from logs, UI, events, repository outputs and
  snapshots; verify the actual process credential-exposure boundary as well.
- Later filesystem edits do not change completed-turn review evidence.
- Cloud compute attribution remains correct when a turn waits on allowance or
  terminates early; inference quota does not become a compute balance.

Codex, Claude and OpenCode v2 have separate release gates. Each may ship when
its whole acceptance path passes; the combined cloud integration scope is
complete when all three pass. Codex/Claude subscription support retains its
separate provider/payer proof. A mockup or isolated adapter package is not
integration completion, and API-key success is not subscription completion.
