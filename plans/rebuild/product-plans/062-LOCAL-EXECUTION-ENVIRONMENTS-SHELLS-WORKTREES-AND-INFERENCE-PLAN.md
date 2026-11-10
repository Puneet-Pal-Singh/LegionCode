# 062 — Local Execution Environments, Shells, Worktrees And Inference

Date: 2026-11-10 (Asia/Kolkata)  
Status: Proposed; research and implementation design, not shipped capability.  
Owner: Existing local App Server, workspace/Git authorities and execution backends.

## 1. Decision and scope

Desktop supports local and managed-cloud execution. Web initially supports
managed-cloud execution. Accountless local execution carries no LegionCode
compute charge. Model usage is a separate choice and may require a subscription
or API payment. Local inference can avoid hosted inference charges when the
user supplies suitable hardware and a compatible model server.

Product flow, clarified 2026-11-10: select **Local or Cloud first**, then select
the **harness**, then select that harness's supported **model/account**.
Both environments offer LegionCode for BYOK and the supported dedicated
harnesses for their respective model/account integrations. Environment choice
does not determine which agent loop the user may select.

Deliver a complete local development environment: files, builds, tests,
terminals, Git, worktrees, temporary projects, durable history and recovery.
Use the same SDK, App Server, kernel and artifacts as cloud execution.

This plan extends local environment capabilities; it does not replace or reopen
the Plan 057 completion program. Keep the current 057 single-executable policy
until its broader replacement passes its own acceptance. Do not make the
independent 048/061 harness tracks wait for this plan or each other.

Existing owners remain authoritative:

| Responsibility | Delivery authority |
| --- | --- |
| Downloadable Desktop, native golden loop, shared UI and packaged acceptance | 057 and its existing LLD |
| Codex, Claude Agent and OpenCode v2 adapters, auth and delegated-loop contract | 048; construction and transport architecture documents |
| The same external drivers inside managed cloud | 061 |
| Full local command/process environment, PTY integration, managed workspaces and local container composition | 062 |
| Local model provider route/catalog/auth semantics | 027/provider-core; 062 owns the local product acceptance |
| Permission profiles and automatic review | 059; no alternative policy engine here |
| Connected-local relay/pairing, cross-device control and handoff | 032/047/048; later than the accountless path |

Native process support and a harness's own process support are separate
capabilities. A working Codex driver does not prove Native shell support.

## 2. What exists and what is missing

Inspection covered the main checkout at `e5f4e4936002ba953e6d47006168cd2ac533e135`
with existing uncommitted changes, plus the clean
`legioncode-057-desktop-integrated` worktree at
`be1d8ac8a1a8635fb462637ae83a989bd5d38696`. These are source observations,
not a claim about the latest dev branch, installer or production deployment.

| Evidence | Implication |
| --- | --- |
| 057 already defines local-only, connected-local and cloud modes | Local is planned; the missing work is capability depth and delivery |
| Desktop main supervises a utility-process App Server; `local-process.ts` binds an ephemeral loopback port | Reuse this host; do not add an Electron-owned agent runtime |
| `event-store/src/local.ts` has one SQLite writer, admissions, lifecycle events, grants and artifacts | Extend the existing local database, not a JSON chat store or second database |
| Local workspace grants, root pins and writer leases exist | Reuse them for workspace identity and mutation coordination |
| `SingleProcessMacSandbox.ts` denies fork and non-self signals, while allowing normal user filesystem/network/IPC authority | It is process restriction, not workspace confinement |
| `RunExecutableTool.ts` accepts an executable and argv, and rejects subprocess workflows | Ordinary package scripts, pipelines and dev servers need another capability |
| `LocalTurnExecutionCapability.ts` gates build mode on real capture ports | Do not advertise editing or command support from interface existence alone |
| `worker-protocol/src/capabilities.ts` already represents shell, long-running work and isolation | Extend this schema narrowly; do not create a second environment manifest |
| `provider-core/src/registry.ts` contains hidden `local-openai-compatible`, with API-key-only auth metadata and broad static capability claims | A catalog entry is not a proven keyless local agent route; correct and wire it before exposing |
| 048 and `HARNESS-INTEGRATION.md` specify native Codex/Claude/OpenCode v2 packages | Reuse those adapters in both execution placements |

The examined integrated tree does not establish a working general-shell,
interactive-terminal, managed-worktree or offline-model product journey.
Verify the branch selected for implementation before editing; other 057
worktrees contain concurrent work.

## 3. Upstream evidence and lessons

Research date: 2026-11-10. T3 source was inspected at
`feb9c6b8425efc05dd0d3b198999ef90e16fc62c`; OpenCode dev source at
`98e4b5343e33aafded479b9ff71c12fd760d9d87`. Pins are research evidence,
not release versions approved for LegionCode.

### Codex

The official [app-server documentation](https://learn.chatgpt.com/docs/app-server)
describes a persistent subprocess API with initialization, typed Thread/Turn
commands, streamed items, approvals and interruption. Use private stdio and
schemas generated from the selected CLI version. Do not scrape a terminal UI.
The network WebSocket transport remains marked experimental/unsupported in the
documentation inspected.

[Sandboxing](https://learn.chatgpt.com/docs/sandboxing) constrains spawned
commands as well as file tools; approval policy is a separate control. Its
platform implementation uses macOS Seatbelt, Linux/WSL bubblewrap and native
Windows sandboxing. Borrow the enforcement and capability model; do not claim
LegionCode's current no-fork policy is equivalent.

[Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees) provide
separate checkouts for parallel work. They are not a filesystem security
boundary. LegionCode must retain its own workspace, Git and artifact owners.

### T3 Code

T3 is a workspace/control application around external harnesses, rather than
its own model/tool loop. Its server owns processes, project files, Git and PTYs;
clients use authenticated RPC. Adopt this host boundary and driver versus
configured-instance separation, using LegionCode's existing SDK and kernel.
See its pinned [architecture](https://github.com/pingdotgg/t3code/blob/feb9c6b8425efc05dd0d3b198999ef90e16fc62c/docs/internals/overview.md),
[provider constraints](https://github.com/pingdotgg/t3code/blob/feb9c6b8425efc05dd0d3b198999ef90e16fc62c/docs/internals/providers.md)
and [FAQ](https://github.com/pingdotgg/t3code/blob/feb9c6b8425efc05dd0d3b198999ef90e16fc62c/docs/user/faq.md).

Source details inspected:

- `apps/server/src/provider/CodexProvider.ts` launches structured app-server;
  `Drivers/CodexDriver.ts` separates configured account/session construction.
- `packages/provider-opencode/src/server/v2/OpenCode2Server.ts` owns a private
  server per instance, supplies an in-memory password and verifies server info.
  It uses the v2 client, not the historical v1 REST contract.
- `apps/server/src/terminal/NodePtyAdapter.ts` runs node-pty outside the renderer;
  its [terminal design](https://github.com/pingdotgg/t3code/blob/feb9c6b8425efc05dd0d3b198999ef90e16fc62c/docs/internals/terminal-runtime.md)
  describes incremental output and bounded retention.
- `apps/server/src/vcs/GitVcsDriverCore.ts` and `worktreeRemoval.ts` own checkout
  creation/removal; a worktree is a managed resource with failure cases.

Do not copy T3's framework, alternate client runtime or projection retention
policy into LegionCode. Its FAQ explicitly separates free application usage
from provider payments and currently says local models are unsupported. Our
local-model support is a deliberate additional product capability.

### OpenCode v2

OpenCode supplies its own local agent loop, tools, provider integration and
background service. Its Desktop connects to that service. This differs from
T3's role as a host for multiple existing harnesses.

Inspected boundaries:

- `packages/desktop/src/main/service/background-service.ts`: versioned service
  ownership, readiness and authenticated endpoint adoption.
- `packages/protocol`, `packages/server` and `packages/client`: typed contracts,
  handlers and generated client; use native v2 for 048.L3.
- `packages/core/src/location-services.ts`: location-scoped services/disposal.
- `packages/core/src/tool/plugin/shell.ts` and `shell.ts`: foreground/background
  commands, file-backed bounded results and process lifetime.
- `packages/core/src/pty/pty.node.ts` and `persistent-pty/daemon.ts`: native PTY
  adapter and separately authenticated persistent-terminal machinery.
- `packages/core/src/worktree/git.ts`: Git strategy for worktree lifecycle.

The current unversioned `/docs/server` and `/docs/sdk` URLs redirect to **v1**
documentation. Do not implement v2 by copying those endpoints or package names.
See the pinned [v2 client README](https://github.com/anomalyco/opencode/blob/98e4b5343e33aafded479b9ff71c12fd760d9d87/packages/client/README.md).

OpenCode's [security policy](https://github.com/anomalyco/opencode/blob/98e4b5343e33aafded479b9ff71c12fd760d9d87/SECURITY.md)
explicitly says its permission prompts are not a sandbox. Its
[model documentation](https://opencode.ai/docs/models/#local) supports Ollama,
LM Studio, vLLM and compatible local endpoints. Adopt the provider flexibility;
add a real isolation backend when isolation is selected.

## 4. Environment-first selection and harness-scoped models

The user-facing flow is:

```text
1. Environment: Local | Cloud
2. Harness: LegionCode | Codex | Claude Agent | OpenCode v2
3. Model/account: choices supported by the selected harness
4. Workspace: repository/folder/worktree on the selected environment
```

The product support matrix is symmetric for Desktop:

| Harness | Desktop → Local | Desktop → Cloud | Web → Cloud | Model/account selection |
| --- | --- | --- | --- | --- |
| LegionCode | Supported target | Supported target | Supported target | BYOK provider and model through LegionCode's provider catalog; optional validated local endpoint |
| Codex | Supported target | Supported target | Supported target | Codex-supported models and the selected supported Codex account/auth route |
| Claude Agent | Supported target | Supported target | Supported target | Claude-supported models and the selected supported Claude account/auth route |
| OpenCode v2 | Supported target | Supported target | Supported target | Models and provider credentials supported/configured through OpenCode |

This is the intended product matrix, not a claim that every integration is
already shipped. Local harness delivery remains 048; cloud harness delivery
remains 061. Local and cloud compose the same driver packages. Installation,
credentials, entitlement and capability readiness are reported on the selected
environment, without making a supported harness permanently local-only or
cloud-only. Web's initial environment is Cloud with the same harness choices.

LegionCode is the BYOK agent harness in the product UI; existing implementation
references to Native mean that harness. Dedicated harnesses own their supported
model/provider selection and authentication. OpenCode can itself support
multiple providers; "dedicated" does not mean that every harness has exactly
one model vendor. Do not display one universal model list or route a dedicated
harness's model selection through LegionCode's BYOK loop.

Isolation and compute/model cost remain explicit environment details and
policy settings, with suitable defaults. They are not four mandatory onboarding
steps. Changing Local to Cloud preserves the selected harness when supported,
but requires destination workspace/account readiness. Host-local credentials
are not transferred implicitly and active attempts are not migrated.

Persist a validated, immutable selection for each admitted Run Attempt:

| Choice | Examples | Owner |
| --- | --- | --- |
| Compute placement | This computer; managed cloud | Environment/workspace authority |
| Agent harness | LegionCode; Codex; Claude Agent; OpenCode v2, in either placement | Existing native/delegated runtime ports |
| Harness-scoped model route and payer | LegionCode BYOK/local endpoint, or the dedicated harness's supported model/account | Provider route or selected harness instance |
| Isolation policy | Current restricted executable; verified harness sandbox; local container; trusted host | Concrete execution backend and permission policy |

Do not offer a Cartesian product of unsupported combinations. The host reports
the capabilities of the exact selection. Approval UI cannot make an unavailable
isolation mechanism real. Changes apply to a new attempt at an explicit boundary;
they never move a running attempt silently.

Local execution backend examples follow. They do not restrict the harness
choices offered in Cloud:

| Combination | Purpose and gate |
| --- | --- |
| Native + existing restricted executable | Preserve current 057 behavior and its truthful limitation |
| Codex + verified workspace sandbox on host | Convenient local CLI-backed coding without requiring Docker; 048.L1 conformance |
| OpenCode v2 + trusted host | Optional familiar OpenCode behavior; disclose full user authority, no sandbox claim; 048.L3 conformance |
| Native/OpenCode + local container | First general-subprocess backend whose resource boundary LegionCode can tear down as a unit |
| Native/OpenCode + local model endpoint | No hosted inference charge, after tool/context and end-to-end acceptance |

Claude uses its existing 048 track and provider-specific auth/permission gate.
Do not expand subscription entitlement claims in this plan.

## 5. Target wiring and ownership

```text
Desktop renderer / Web client -> shared client UI -> SDK
                                                    |
                                         environment binding
                                       /                   \
                              Local                         Cloud
                        local App Server              hosted App Server
                              |                             |
                     runtime + SQLite              runtime + hosted store
                              |                             |
                     harness selection              harness selection
                      /             \                /             \
                 LegionCode      Dedicated      LegionCode      Dedicated
                 BYOK/model      harness +      BYOK/model      harness +
                 provider        its models     provider        its models
                      \             /                \             /
                       local backend                  cloud backend
                              |                             |
                    local files/shell/Git          cloud files/shell/Git
```

This diagram shows two placements of the same runtime contracts and harness
packages, with separate environment-bound instances and persistence. Both paths
include native and delegated loops. Web initially binds only to Cloud; Desktop
can bind to either. There is no separate "cloud agents" harness category.

Electron main retains dialogs, keychain and process supervision. Renderer has
no Node, arbitrary IPC, child-process or filesystem primitive. The loopback
connection remains authenticated and origin/host validated.

Keep existing owners: runtime decides lifecycle/approval; event-store persists;
workspace-core plus local workspace service authorize roots; git-service owns
Git; provider-core owns Native model routing; harness-core owns external process
plumbing; drivers translate external observations. Backend output enters the
kernel append path before publication. No shell/PTY service decides Turn status.

Implementation locations, created only with a working consumer:

| Work | Location |
| --- | --- |
| Selection and truthful capability schema | Existing platform-protocol and worker-protocol modules |
| Native subprocess/container/PTY adapters | Focused `execution-engine/src/runtime/local/` modules behind worker ports; extract touched reusable desktop process logic |
| Workspace provisioning and root authorization | Existing `app-server/src/local-workspace*` composition and workspace-core |
| Worktree commands and metadata resolution | git-service, composed by local workspace owner |
| Local commands/terminal operations | Existing App Server dispatch and SDK; typed operations, no raw client spawn |
| Durable terminal/workspace references | Existing local SQLite writer and repositories |
| Terminal and environment UI | Shared client-ui surfaces with platform adapters |
| External drivers and supervision | Exact harness-core/codex/claude/opencode map in HARNESS-INTEGRATION.md |

Do not revive the legacy ExecutorRouter as another policy authority, introduce
`local-runtime` as another kernel, or copy the hosted runtime into Desktop.

## 6. Files, temporary data and workspace forms

Support three workspace forms through one canonical workspace record:

1. **Existing folder:** user grants a root through the native picker. A non-Git
   folder supports files/tools without inventing Git metadata or initializing a
   repository automatically.
2. **Managed Git worktree:** default suggestion for a concurrent coding task.
   Record source repository identity, base commit, checkout identity and branch
   or detached state. Keep worktrees outside the source checkout.
3. **Scratch project:** app-managed persistent folder for experiments or new
   projects. It survives restart; Export/Move promotes it to a user location.
   Git initialization is a separate explicit action.

Keep durable app data under the existing OS app-data directory:

```text
<app-data>/
  local-events.sqlite       existing canonical local database
  artifacts/                immutable output under existing artifact ownership
  sessions/<instance>/      harness configuration/session state, not product truth
  logs/                     bounded, redacted diagnostic tails
  cache/                    disposable downloads and indexes

<managed-workspace-root>/<workspace>/
                            app-managed worktrees or scratch roots
```

The managed workspace root is disjoint from protected app state and source
repositories, with its own host-authorized provisioning/grant. The current host
protects its entire storage directory, so putting writable projects beneath it
would conflict with that boundary. Do not weaken the protected-root check or
relocate existing state merely to make workspace creation pass.

Use an OS temporary directory only for per-attempt scratch, atomic staging and
spooled output whose retention policy permits removal. It is not the sole copy
of a workspace, thread, credential or completed review. Temp locations are
private, generated by the host and never trusted from a client path.

Preserve existing media/artifact storage layout where already implemented;
this tree specifies retention classes, not a mandatory data relocation.
Cleanup uses a journal/lease, verifies ownership and refuses busy resources.
Never recursively delete a selected user folder. Dirty managed worktrees and
unexported scratch projects require explicit discard or retention.

## 7. Shells, terminals and background resources

Agent shell execution and an interactive user terminal are different APIs over
the same authorized workspace/environment. Neither is a prompt-parsing trick.

Agent commands need: exact cwd, chosen shell or argv, sanitized environment,
timeout, cancellation, bounded live output, spool/artifact references, exit code
and observed resource closure. Keep structured argv for direct commands. When
shell syntax is requested, invoke the selected shell explicitly and apply
policy to the complete command; token matching is not containment.

In-app terminals use a host-owned PTY adapter such as
[node-pty](https://github.com/microsoft/node-pty), packaged for the
actual Electron/Node ABI. Expose typed create/attach/input/resize/close methods
using opaque resource IDs, never arbitrary renderer executable paths. Terminal
rendering stays in shared UI. Start with
[xterm.js](https://xtermjs.org/docs/), following its flow-control and security
guidance; no terminal-emulator rewrite. For container terminals, attach to the
engine's PTY inside the container; a host PTY running `docker exec` is not itself
the isolation boundary.

Separate resource states from Turn states:

- A foreground command belongs to its attempt and must close for settlement.
- A dev server intentionally retained after a Turn becomes a tracked background
  resource. Its write access continues to block an exclusive capture/commit
  unless the capture model explicitly supports that resource.
- An interactive terminal is user-controlled. Concurrent writes prevent strict
  agent-only diff attribution; require exclusive checkout access or label the
  result as observed workspace changes. Never call a PTY input agent-approved
  merely because the user terminal is open.
- Disconnecting a renderer does not imply Stop. Initially, explicit app Quit
  stops owned local work; window close follows the documented app lifecycle.
  A later keep-running setting needs a separately supervised host.
- Host death does not preserve a shell by persisting its PID. Reattach only to
  a proven live resource generation; otherwise show unavailable/recovery needed.

Bound server and renderer scrollback independently, stream incremental chunks,
and keep logs out of unbounded lifecycle payloads. Historical terminal replay
must never send input or device-query responses to a live shell.

## 8. Isolation and process lifetime

Worktree separation, working directory, permission prompts and Electron renderer
sandboxing do not confine an agent's native child processes.

For every backend report filesystem scope, network scope, process lifetime,
credential exposure and supported controls separately. Existing coarse isolation
enums remain useful but are insufficient to promise workspace confinement.

**Local container delivery:** implement one Docker-compatible engine first.
Detect availability; installation is a user setup action. Docker-compatible
describes an integration target, not a promise about third-party runtime
licensing or subscriptions. Do not bundle or
require Docker for existing restricted or supported external-host execution.
Probe compatibility before enabling another engine.

- Dedicated container per active mutating attempt initially; persist its owned
  identity/generation until cleanup is proven. Separate retained dev-server
  containers are explicit resources, not accidental descendants.
- Mount only the selected managed checkout and scoped caches; never the whole
  home, SSH agent, Docker socket, app database or credential directory.
- Run without privileged mode, with a non-root user, dropped capabilities,
  explicit memory/CPU/PID limits and an owned writable temp area.
- Network is an explicit policy. Network-off is enforceable by the engine;
  domain-restricted egress requires a real proxy/firewall, not an allowlist in
  model instructions. Model traffic needs its own route when tools are offline.
- Keep Native inference credentials outside tool execution. External harnesses
  may require credentials in their own environment; show that exposure and use
  short-lived/scoped credentials where the provider supports them.
- Stop tears down the owned container/process namespace, confirms removal/exit,
  then permits capture and lease release. Engine loss leaves the workspace busy
  or quarantined until reconciliation establishes safety.

Implementation references: Docker's
[resource constraints](https://docs.docker.com/engine/containers/resource_constraints/)
and [network-off driver](https://docs.docker.com/engine/network/drivers/none/).
Do not combine network-off with a required TCP model gateway in the same
container; keep Native inference in the host or use a separately enforced,
scoped route. State which boundary the offline acceptance actually proves.

Linked worktrees share Git metadata. A `.git` file may point outside the mounted
checkout; mounting the entire common directory writable would expose sibling
refs and indexes. Initial isolated mode uses a private managed checkout/clone
with host-owned import/export, or a separately proven metadata mount/proxy.
Never assume an arbitrary worktree bind mount makes Git both functional and
isolated. The host performs canonical ref publication with expected-ref checks.

**Host harness delivery:** use the harness's actual supported sandbox or an
explicit trusted-host profile. A container cannot access macOS apps or the
user's normal OS session simply because it runs locally. Native host mode is
not equivalent to the managed container.

**Subprocess cleanup gate:** process-group kill is best effort on a trusted
host; descendants can detach. Do not remove fork denial from 057 based only on
successful `killpg`. A new Native host-shell backend requires its own containment
and crash/descendant proof. Until then, use the container for broad Native
subprocess execution. Existing independent harnesses prove their declared
controls under 048; this does not grant stronger generic host guarantees.

Generalize the existing lease's resource receipts beyond
`SingleProcessMacExecution` only when the new backend is wired. Unknown cleanup
retains the fence; a timeout never becomes proof of closure.

## 9. Git, parallel agents and completed review

One mutating attempt per physical checkout. Parallel mutating tasks use separate
worktrees/private checkouts. Read-only concurrency still requires an explicit
consistency policy. No global lock for all unrelated repositories.

Use a checkout mutation lease and a separate short repository-metadata lock for
operations on common refs/worktree registration. Different worktrees share a
repository; checkout separation alone does not serialize common Git mutations.

The canonical Git service creates/lists/removes worktrees and commits/publishes
reviewed changes. Resolve main checkout, per-worktree gitdir and common gitdir;
respect granted identities, submodules, hooks and supported configuration.
Hooks/setup scripts execute code and need the chosen execution policy.

Default worktree creation starts from an exact commit. Uncommitted source changes
are not silently copied or stashed. Offer a separate snapshot transfer when
supported and accepted. Record imported provenance and conflicts.

External harness shell tools may run Git internally. Do not claim git-service
exclusivity if arbitrary shell still permits commit/reset/push. The integration
must enforce its declared restriction, run against private metadata with
host-owned publication, or decline that strict policy. Instructions and shell
regexes do not prove exclusive Git authority. Keep ordinary inspection available
where supported without letting it become another ref/index mutation owner.

After actual quiescence, capture baseline/final immutable artifacts through the
existing owner. Completed review reads that artifact even after further edits,
restart or worktree cleanup. Committing a selected completed Turn uses its
captured content and expected branch/ref, not `git add` of today's files.
Push and PR creation require network, configured remote auth and explicit policy;
offline local edit/test/review/commit do not require GitHub or LegionCode login.

## 10. Local inference and billing

Initial local model support connects to an already running server. Do not build
a model downloader, GPU scheduler or inference engine in this plan.

Native connects through provider-core and the existing provider adapter registry.
Use a dedicated configurable OpenAI-compatible route; compatibility does not
imply that the server implements OpenAI's Responses API. Probe the actual chat,
streaming and tool-call contract. Support optional authentication; do not require
a fake paid API key for a keyless local server.

Validate model IDs, context/output limits, tool-call behavior, streaming errors,
vision availability and cancellation. `/models` discovery alone does not prove
tools work. Do not infer capabilities from a friendly model name or reuse the
hidden provider's broad static capability defaults without proof.

For Ollama, use its supported
[tool-calling contract](https://docs.ollama.com/capabilities/tool-calling) or the
verified compatible API route; do not assume every installed model supports it.

For an external OpenCode harness, its provider configuration owns local model
selection. Show it as harness-managed; do not silently reroute its inference
through Native. A model switch does not switch agent loops.

Loopback belongs to the process making the request. In a local container,
`127.0.0.1` is the container, not the Mac's Ollama/LM Studio service. Provide an
explicit scoped host gateway/proxy for that route; do not switch the container
to host networking or expose the model service publicly. A configured remote
endpoint must not carry an on-device/offline badge.

Accountless local acceptance must work with LegionCode cloud unavailable. Fully
offline acceptance additionally blocks external network and disables hosted
models, web search, remote MCPs, telemetry and cloud title/summary dependencies.
Use deterministic titles or the selected local route. Prompt/file content may
still leave the machine when the user selects hosted inference or remote tools.

Show two independent cost sources:

| Execution and inference | LegionCode compute charge | Other cost |
| --- | --- | --- |
| This computer + local model | None | User hardware, power and storage |
| This computer + provider API | None | Provider usage |
| This computer + supported subscription harness | None | Subscription/entitlement and its limits |
| Managed cloud + any supported inference route | Managed compute/storage policy | Selected model/provider route separately |

Local concurrency is bounded by user-configurable hardware/process/disk budgets,
not a cloud credit balance. Cloud usage remains metered under existing billing.
Never move work to paid cloud automatically when local resources run out.

## 11. Computer and operating-system access

Local coding tools do not automatically include screen control, application
automation or browser access. Host filesystem authority also differs from OS
Accessibility/Screen Recording consent.

Expose computer/browser control as separately permissioned capabilities through
the same tool registry, using supported native helpers/MCP adapters. Keep them
outside Electron renderer privileges. Explicit app/path/origin scopes and native
OS grants apply. Container tools cannot operate the host desktop without a
separately authorized bridge. Defer full computer-use delivery until a concrete
workflow requires it; keep a truthful unavailable state in the initial release.

## 12. Implementation slices and dependency rules

### 12.1 Built-ins first; ACP is follow-on scope

The initial supported harness scope is LegionCode/BYOK, Codex, Claude Agent and
OpenCode v2 in Local and Cloud. This is a product priority, not a verified
"80 percent market share" claim. Release a driver/placement only when its own
acceptance passes; the four-harness target does not force a ready integration
to wait for every other integration or for all plans to close.

Keep the shared host/driver contract extensible to ACP without implementing
unused registry infrastructure now. Follow-on 048.L6 proceeds from installed
custom ACP command (L6a), to registry discovery/managed local installation
(L6b), to curated cloud execution (L6c). Begin that implementation after the
built-in acceptance milestone for the target placement and a proven shared
host contract. This is not a requirement to finish unrelated 061 quota/UI work.
ACP transport and registry distribution are separate responsibilities; neither
is a prerequisite for 057/061/062 completion or a native-session fallback.

### 12.2 Parallel lanes and concrete dependencies

Start the applicable next slice in each lane without waiting for full 061:

| Lane | Work that can proceed now | Actual prerequisite for integration/release |
| --- | --- | --- |
| 057 Desktop | Existing shell/shared UI, local host integration, packaging and native golden-loop slices | Each LLD slice's reviewed boundary and packaged proof; a cloud feature consumes its ready 061 hosted capability |
| 048 local harnesses | Codex, Claude and OpenCode native drivers and local host composition | Canonical admission/approval/replay/artifact integration plus that driver's auth and execution proof; no full 061 gate |
| 061 cloud harnesses | Hosted bridge, sandbox composition, connection custody and per-driver cloud conformance | The same driver package/contract and cloud isolation/auth proof; no full 057/048 gate |
| 062 local environment | Environment-first selection, workspace/Git provisioning and general subprocess/terminal/local-model slices | Existing ready backend or the missing capability wired in the consuming slice; build on current 057 work without claiming it complete |

Shared-code coordination is required even when lanes proceed concurrently:

1. Assign one implementation owner to each driver package. Local and cloud
   composition work consume that same package; do not build two Codex/Claude/
   OpenCode drivers or competing credential/lifecycle state machines.
2. The first real local or cloud consumer seeds a missing shared port with a
   working vertical slice. Others integrate that reviewed change rather than
   block on an entire numbered plan or create disconnected foundation code.
3. Serialize overlapping edits to platform-protocol, runtime-kernel admission/
   append/approval, workspace leases, Git capture, App Server dispatch and SDK
   continuation through a named owner. Keep unrelated host/UI/backend work
   independent and merge small reviewed slices frequently.
4. A blocked provider subscription route affects only that route. Supported
   API-key integration can proceed without advertising subscription completion.
5. Preserve independent per-driver/per-placement gates. Working cloud execution
   does not prove local containment; a local CLI does not prove cloud custody;
   neither proves installed Desktop readiness without packaged acceptance.

This is the scheduling decision, not a claim that implementation agents have
been started or existing implementation work has been completed. Follow the
repository's existing branch/worktree and review rules when executing it.

### 12.3 Local implementation slices

Each slice is a runnable vertical product change. Reuse existing test files and
registrations per AGENTS.md; do not add interface-only scaffolding or new test
suites. Extend existing assertions and use recorded real product acceptance.

| Slice | Concrete result | Dependencies and acceptance |
| --- | --- | --- |
| 062.A — Environment-first harness selection | Desktop selects Local or Cloud, then LegionCode/BYOK or a dedicated harness and its supported model/account; isolation/cost appear as environment details | Existing SDK/host bindings; verify the same supported harness list for both placements, harness-scoped model lists, destination readiness, accountless local use and no silent fallback |
| 062.B — Managed workspaces | Existing folder, scratch folder and managed worktree can each run a real supported agent task | Existing workspace/Git owners; prove dirty-source handling, distinct writer scopes, restart and safe cleanup |
| 062.C — General local subprocesses | Native edits a managed local checkout and runs its real package test command inside a local container | Existing captured build path plus selected engine; prove child/daemon termination, engine failure and immutable review |
| 062.D — In-app terminals and dev servers | User opens a real terminal, resizes, reconnects and stops a dev server in the selected environment | Supported execution backend; prove bounded output, terminal ownership and capture/lease interaction |
| 062.E — Local model route | Native performs read → edit → actual test → review with an existing Ollama/LM Studio/compatible endpoint and no cloud auth | Provider-core wiring and a usable local execution backend; prove blocked-WAN journey, tool support, cancellation and container-to-host routing |
| 062.F — Packaged local acceptance | Clean-profile Mac install supports the delivered local combinations with history after restart and usable recovery | The completed capabilities above plus 057 packaging owner; honest per-harness/backend support matrix |

062.B and 062.C share workspace/Git integration; deliver the first consumer
together if separating them would create disconnected code. 062.D can ship
against an already supported 048 backend without waiting for Native containers.
The local model provider work can start independently of 062.C; its complete
Native coding journey needs a real usable command backend.

048.L1/L3/L4 remain independent local harness deliveries. They do not wait for
062.F, the Native golden loop, or another driver. 061 cloud work continues
independently. Windows/Linux support requires platform-specific acceptance;
do not advertise them from a successful Mac package or Docker-only test.

Within each slice: trace active owners, wire a real consumer, migrate affected
consumers, delete replaced authority, then prove SDK replay/live/settlement.
Keep 057's restricted capability until the applicable replacement works; do not
silently upgrade or redirect an already admitted attempt.

## 13. Acceptance and release boundary

Use an ordinary development repository and its existing checks, not a special
single-process fixture, for general-command acceptance:

```text
Install → choose Local
→ choose LegionCode/BYOK or a dedicated harness and its supported model/account
→ grant repo or create managed worktree
→ ask for a real change → inspect files → approve when required
→ edit → run package-manager test/build with subprocesses
→ observe progress → interrupt a second long-running attempt
→ inspect immutable review → commit selected work locally
→ restart → same history, requests, result and review
```

Also demonstrate:

- Desktop's Local and Cloud environment choices each offer LegionCode, Codex,
  Claude Agent and OpenCode v2 as delivery targets. Web Cloud offers the same
  harness choices. Verify destination readiness and each harness's own model
  list; missing setup must not silently select another loop or provider. Cloud
  driver proof is supplied by the independent 061 delivery, not rebuilt here.
- Two parallel agents on separate checkouts; same-checkout writer rejected.
- Ordinary and linked worktrees, dirty tree, non-Git folder and scratch export.
- Symlink/path traversal rejection in restricted file tools; container mount and
  network policy enforcement; trusted-host authority presented accurately.
- Child and detached-process handling, crash during mutation, stale PID/host
  generation, engine disconnect, lease quarantine and no automatic tool retry.
- Renderer reconnect during approval; no duplicate prompt/tool/decision/final.
- Model missing, model server down, malformed tool calls, unsupported context,
  cancellation and no model/cloud fallback.
- Cloud unavailable versus fully blocked WAN as two separate acceptance cases.
- Missing Git/container/CLI, incompatible versions, disk full and cleanup refusal
  with retained work. Setup actions never occur as health-check side effects.
- Provider and local-host credentials excluded from renderer, logs and Native
  tool environments; external-harness credential exposure documented honestly.
- Closing/reopening the window and explicit Quit follow the published lifetime
  policy; restart does not fabricate completion or rerun ambiguous commands.
- Current cloud Web behavior still works through its existing owner.

Run focused existing typechecks/tests for touched packages, import-boundary
checks, packaged Mac acceptance and `git diff --check`. Record actual commands,
versions, backend/policy and observed limitations in the implementation PR.

No feature is complete from a package build, catalog row, interface, mock-only
proof or successful process launch. Release only the harness/backend/model
combinations that pass their real acceptance path.
