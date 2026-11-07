# 057 — Local-First Desktop Vertical Slices And Shared Client Extraction

Date: 2026-09-18  
Status: In progress through the phase-wise PR train defined by the execution
LLD; each implementation slice still requires its own reviewed, green PR.  
Owner: Desktop shell + local LegionCode App Server + shared client surfaces

Execution-level design:
`LLD/057-local-first-desktop-golden-loop.md`

Corrective status as of 2026-09-27: 057.1 and 057.4 are complete for their
scoped responsibilities. 057.2 and 057.5 are functionally useful but remain
architecturally partial. Their shared workspace/sidebar correction is open in
[PR #442](https://github.com/Puneet-Pal-Singh/LegionCode/pull/442) and is not
complete while required checks fail and substantive review is absent. The
Desktop SDK transport correction remains pending. No 057.6 runtime work may
merge until 057.C1 and 057.C2 in the LLD pass.

Progress: 057.1 merged to `dev` in
[PR #437](https://github.com/Puneet-Pal-Singh/LegionCode/pull/437) at
`ae3f643973f4aa9cc75738b668d3e390036adc5c` on 2026-09-19. Slice 057.2
merged to `dev` in [PR #438](https://github.com/Puneet-Pal-Singh/LegionCode/pull/438)
at `88c73c4e266490bdd2f1d8d884226fc35f627ecf` on 2026-09-20. Slice
057.3 merged to `dev` in [PR #439](https://github.com/Puneet-Pal-Singh/LegionCode/pull/439)
at `b62e9d99e393354f4bd8ef17219bc87cca4dc742` on 2026-09-20. Slice
057.4 merged to `dev` in [PR #440](https://github.com/Puneet-Pal-Singh/LegionCode/pull/440)
at `0e6d1344c7ae5c8842e8c9388fbe5a4e574cd066` on 2026-09-20. Slice
057.5 merged to `dev` in [PR #441](https://github.com/Puneet-Pal-Singh/LegionCode/pull/441)
at `0bd994dafea15d5c519ac5c0d67c81e2ecb0dccd` on 2026-09-20. Slice
057.C1 merged in [PR #442](https://github.com/Puneet-Pal-Singh/LegionCode/pull/442)
at `eb6e70ebaa164b8249b4547439399a404dae2d35` on 2026-10-03 (Asia/Kolkata),
after all required checks and the independent Sol-high review recorded on the
final revision. 057.C2 merged in [PR #445](https://github.com/Puneet-Pal-Singh/LegionCode/pull/445)
at `7b916e03dabff701a165a91927f7ba87fa649a7b` on 2026-10-03, with all required
checks, both actual macOS packaged tests, and an independent Sol-high review
recorded on final revision `44ec796f624ff72337cd1fd76121566bc3b5b865`.
CodeRabbit's skipped `dev` review is not counted as successful. 057.6A merged in
[PR #446](https://github.com/Puneet-Pal-Singh/LegionCode/pull/446) at
`00f1401d15cb39c66734daa7e5bb53431bf6d65d` on 2026-10-04 (Asia/Kolkata),
independently reviewed on revision `9b17fce2088d421035d22c55f115dcc2bfba7a7a`
(review `5402936741`). Required remote gates and final actual packaged smoke
2/2 passed; acceptance is recorded in PR comment `5973923782`.
057.6B merged in [PR #447](https://github.com/Puneet-Pal-Singh/LegionCode/pull/447)
at `2e9c652a5ffa4149478d826019feb7570ffb3c31` on 2026-10-04 (Asia/Kolkata).
Exact revision `ba4a741943ebcb018be2ead9e1bb9536eb1806bc` received independent
Sol-high architecture/security review `5407466061`; all required remote gates
and macOS package acceptance passed. Actual clean-profile protected credential
save/replace/restart/delete and existing native-boundary/grant proofs passed
3/3; acceptance is recorded in comment `5982919479`. Web and Desktop consume
the same extracted existing provider chooser/icon; hosted policy is unchanged.
057.6C is beginning from the new latest `origin/dev`; shared conversation/composer
and read-only native Turn remain its full acceptance scope. 057.6D and
057.7A–057.8B remain pending. The LLD is the single execution authority through full Plan 057
completion; do not create a second competing completion plan.

Coordinates with:

- `006-CLI-DESKTOP-LOCAL-WORKER-ROADMAP-PLAN.md`
- `026-PUBLIC-LEGIONCODE-SDK-AND-ACP-SERVER-PLAN.md`
- `030-LEGIONCODE-SDK-APP-SERVER-DESKTOP-READINESS-PLAN.md`
- `032-LOCAL_CLOUD_SYNC_REMOTE_EXECUTION_AND_HANDOFF_PLAN.md`
- `046-VSCODE-AGENT-HOST-PROTOCOL-AND-MULTI-CLIENT-RUNTIME-ADOPTION-PLAN.md`
- `047-PLACEMENT-NEUTRAL-PRODUCT-CONVERGENCE-AND-EXECUTION-GOVERNANCE-PLAN.md`
- `048-PAIRED-LOCAL-HOST-AND-MULTI-HARNESS-ADOPTION-PLAN.md`
- `056-THIN-WEB-CLIENT-AND-RESPONSIVE-AGENTS-CUTOVER-PLAN.md`

## 1. Objective

Ship a downloadable, useful LegionCode Desktop application before continuing
the broad Plan 056 Web extraction.

Desktop begins as a tiny working Electron application and grows through small,
demoable vertical slices. Each slice must connect its UI, SDK/App Server
boundary, local implementation, persistence, and acceptance proof before the
next responsibility is extracted.

The plan deliberately rejects this migration shape:

```text
create many empty packages
-> move disconnected logic into them
-> leave Web on the old path
-> attempt one large wiring cutover
```

The required shape is:

```text
ship a working Desktop shell
-> choose one user-visible capability
-> characterize the existing Web behavior
-> extract only the reusable contract and presentation needed by both clients
-> wire Desktop and Web to it in the same PR train
-> delete the replaced duplicate path
-> demo and gate both clients
-> repeat
```

At every merge point:

1. the current Web product remains demoable;
2. the Desktop artifact launches and demonstrates its completed capabilities;
3. no extracted package is disconnected from a real client;
4. no second product state machine or lifecycle owner is introduced.

## 2. Product Decision

LegionCode has three deployment modes over one product model.

### 2.1 Local-only

- no LegionCode account required;
- Desktop launches a loopback-only local LegionCode App Server;
- workspace files, Git, terminal, harness processes, provider authentication,
  events, artifacts, and local thread data stay on the user's machine;
- the user supplies compute and inference;
- LegionCode orchestration is free;
- no hidden cloud dependency is allowed for the local golden path.

### 2.2 Connected local

- login is optional and explicit;
- login enables device discovery, authenticated remote control, selected
  metadata/event synchronization, collaboration, and later handoff;
- the local host continues to own its workspace, Git state, terminals, harness
  processes, and provider credentials;
- connecting an account must not silently upload repository contents or local
  credentials;
- a local-only thread becomes connected only through an explicit attach/publish
  action; V1 does not attempt an implicit offline merge.

### 2.3 Cloud

- login and billing are required;
- LegionCode supplies isolated compute, storage, and environment lifecycle;
- the user supplies model inference through a supported provider key,
  subscription-backed harness, or enterprise gateway;
- cloud execution is another `ExecutionEnvironment`, not another Thread,
  Turn, approval, transcript, review, or UI model.

## 3. Correct Architecture

```text
Web entry                         Desktop entry
browser auth/storage adapter      Electron main + typed preload adapter
       \                              /
        \                            /
            shared client UI
                    |
             @legioncode/sdk
                    |
          LegionCode App Server
             /              \
      local composition    hosted composition
             |              |
      local execution      cloud execution
```

One product capability has one canonical contract and one shared presentation
where the interaction is truly the same. Platform-specific behavior is
injected through narrow adapters.

### 3.1 Desktop is a client, not the runtime

The Electron renderer:

- renders the same shared React product surfaces as Web;
- calls `@legioncode/sdk`;
- receives canonical replay plus live continuation;
- has no Node.js, shell, raw filesystem, Git, provider-secret, or Electron
  privilege;
- never imports runtime, persistence, harness, sandbox, or cloud adapters.

Electron main/preload:

- owns window lifecycle, menus, updates, native dialogs, OS keychain access,
  deep links, notifications, and local App Server process supervision;
- exposes a small typed capability API, not raw `ipcRenderer`, filesystem, or
  shell primitives;
- validates every IPC input;
- never becomes a second lifecycle, thread, workspace, or approval owner.

The local App Server/runtime host:

- owns local workspace grants, Git, tools, terminals, harness processes,
  provider integration, events, artifacts, and durable local product state;
- binds to loopback by default with an unguessable per-launch credential;
- exposes the same protocol semantics that a hosted client uses;
- remains independently hostable later for CLI, LAN, Tailnet, SSH, or paired
  remote access.

### 3.2 Electron security defaults

Every Desktop window must use:

- `contextIsolation: true`;
- `nodeIntegration: false`;
- renderer sandboxing enabled;
- a bundled local renderer in production, never a mutable remote Web URL;
- explicit navigation and new-window denial/allowlisting;
- a typed, method-specific preload bridge;
- schema validation and authorization again at the receiving boundary;
- no provider secrets, pairing tokens, or repository contents in renderer
  storage or logs.

## 4. One UI Source, Two Builds

Web and Desktop must not copy the application UI.

They produce two platform bundles from shared source:

```text
packages/ui-kit
  reusable low-level visual primitives

packages/client-ui
  shared LegionCode product screens and feature composition

packages/sdk
  the one public typed client, connection supervision, environment selection,
  SDK-backed controllers, replay/continuation, and reusable read models

packages/app-server
  the one independently hostable server boundary, including its internal
  protocol, transport handling, commands, queries, and subscriptions

apps/web
  browser entry, hosted auth adapter, URL routing, browser preferences,
  service-worker/browser integration, Web deployment

apps/desktop
  Electron main, preload, Desktop renderer entry, native platform adapters,
  packaging, updater, local App Server supervision
```

`packages/client-ui` is a destination name, not permission to perform a bulk
move. It is created only when one specific extracted capability has both Web
and Desktop consumers in the same slice. The current
`packages/platform-client-sdk` migrates atomically to `packages/sdk`; no second
client runtime, public protocol client, or SDK package is created.

Rules:

1. Desktop does not import from `apps/web`.
2. Web does not import from `apps/desktop`.
3. Shared code does not detect its platform through scattered
   `window.electron` branches.
4. Platform behavior is provided through narrow ports such as
   `FilePickerPort`, `CredentialStorePort`, `ExternalLinkPort`,
   `NotificationPort`, and `ClientLifecyclePort`.
5. A port is added only when a completed vertical slice requires it.
6. Responsive layout belongs to shared client UI when Web and Desktop render
   the same screen.
7. Window chrome, native menus, updater UI, and OS integration remain Desktop
   responsibilities.
8. Hosted login and browser-only navigation remain Web responsibilities.

The same React source is compiled into both the browser and Electron renderer
bundles. This is source reuse, not loading the cloud Web app inside Electron.

### 4.1 Public versus internal package surface

LegionCode exposes two product boundaries:

```text
@legioncode/sdk
@legioncode/app-server
```

`platform-protocol` remains the internal canonical domain-schema owner while
it is needed by runtime and persistence packages. App Server wire envelopes,
handshake, transports, and the SDK's low-level connection implementation are
internal modules of App Server and SDK respectively unless independent public
consumers prove a separate package is necessary.

Do not create or publish parallel `app-server-protocol`, `app-server-client`,
or `client-runtime` packages merely to mirror Codex's internal Rust crate
layout. Codex uses multiple internal crates to enforce Rust boundaries, while
its public TypeScript consumer surface remains one SDK. LegionCode copies the
public simplicity and keeps internal TypeScript modules cohesive until scale
or independent reuse justifies another package.

### 4.2 Desktop directory owns Desktop

All Desktop-specific files remain under one application directory:

```text
apps/desktop/
  src/main/
    windows/
    menus/
    server/
    settings/
    credentials/
    updates/
    diagnostics/
  src/preload/
  src/renderer/
    entry/
    platform/
  resources/
  scripts/
  tests/
  electron-builder.config.ts
  package.json
```

Do not distribute Electron settings, updater logic, native menus, window state,
packaging, or local-host supervision across central packages. Only code that is
actually consumed by another client moves out of `apps/desktop`.

### 4.3 Upstream structure evidence

Current Codex OSS has internal Rust crates for App Server protocol, transport,
and clients because those are independently enforced Rust compilation
boundaries. Its public TypeScript embedding surface is one
`@openai/codex-sdk`. LegionCode should not translate every Rust crate into a
published TypeScript workspace package.

References:

- <https://github.com/openai/codex/tree/main/codex-rs/app-server>
- <https://github.com/openai/codex/tree/main/codex-rs/app-server-client>
- <https://github.com/openai/codex/tree/main/sdk/typescript>

Current OpenCode keeps its core business logic and server under
`packages/opencode`, exposes one `@opencode-ai/sdk`, keeps shared product UI in
`packages/app`, and keeps Electron main/preload, native settings, updater,
packaging, and server supervision together under `packages/desktop`. Its
Desktop application wraps the shared app instead of copying it.

References:

- <https://github.com/anomalyco/opencode/blob/dev/CONTRIBUTING.md>
- <https://github.com/anomalyco/opencode/tree/dev/packages/app>
- <https://github.com/anomalyco/opencode/tree/dev/packages/desktop>
- <https://github.com/anomalyco/opencode/tree/dev/packages/sdk/js>
- <https://github.com/anomalyco/opencode/tree/dev/packages/opencode>

## 5. Cloud Directory Decision

Do not create a generic `cloud/` source-code bucket.

Cloud-specific resources need an explicit deployment boundary, but canonical
product logic must not move under a Cloud directory.

Target ownership:

```text
infra/cloud/
  Cloudflare/AWS/GCP deployment definitions, environment manifests,
  queues, databases, secrets bindings, budgets, alarms, and runbooks

apps/brain/
  existing hosted authentication, tenancy, admission, routing, and App Server
  composition until a separately approved rename is justified

apps/secure-agent-api/
  existing managed cloud execution adapter until its canonical replacement is
  wired and proven

packages/app-server/
  placement-neutral server, internal wire contract, commands, subscriptions,
  and hosted/local composition ports

packages/sdk/
  the one public client, transport implementation, continuation, and reusable
  projections

packages/runtime-kernel/
packages/workspace-core/
packages/git-service/
packages/provider-core/
  placement-neutral product policy and domain ownership

apps/desktop/
  Desktop client, native platform adapter, and local App Server supervision
```

Cloud vendor code may live in a clearly named adapter package only after a real
second composition needs that boundary. Do not create `packages/cloud-core`,
copy runtime logic into `infra/cloud`, or move shared domain rules under Brain.

The immediate plan does not relocate the existing cloud apps. First add a
boundary gate preventing Desktop or shared client packages from importing
them. Physical cloud-folder cleanup happens only with a wired replacement and
a separate deletion-focused PR.

## 6. Canonical Identity And Placement

Keep these identities separate:

```text
Environment
  -> owns reachable compute and capabilities

Workspace
  -> repository/environment boundary on one environment

Thread
  -> durable conversation associated with a workspace

Turn
  -> one user request lifecycle

Run Attempt
  -> one execution attempt bound to an exact environment, workspace checkout,
     harness instance, and provider route
```

A client may read any authorized synchronized Thread. It may execute a new Turn
only on an online, authorized, compatible environment that can materialize the
Thread's workspace.

Environment changes are explicit handoffs. There is no silent local-to-cloud
fallback and no two-host ownership of one active Run Attempt.

## 7. Vertical PR Program

Each PR must produce a runnable artifact or visibly useful capability. A later
slice may subdivide when needed, but it may not combine multiple incomplete
layers into a disconnected architecture PR.

### 057.1 — Downloadable Electron hello-world shell

Create `apps/desktop` with:

- Electron main process;
- sandboxed renderer;
- context-isolated typed preload bridge;
- one window showing `Hello from LegionCode Desktop` and build/version data;
- development and production launch commands;
- packaged artifact for one primary OS;
- smoke test proving the packaged app launches and renders;
- CI artifact generation without signing/notarization unless credentials are
  already available.

No App Server, account, workspace, harness, provider, or copied Web UI exists in
this slice.

Exit gate:

- a user can download, install/open, and close the artifact;
- production renderer contains no Node privilege or remote URL;
- the existing Web product is unchanged.

### 057.2 — Shared visual shell consumed by Web and Desktop

Characterize the smallest existing Web shell behavior: theme, typography,
error boundary, loading state, and top-level layout.

Extract only that slice into `packages/client-ui` and wire both:

- Web continues rendering the same shell;
- Desktop replaces hello world with the same shared shell;
- browser and Desktop entry adapters remain separate;
- screenshots prove visual parity at agreed viewport sizes.

Exit gate:

- one shared shell source is rendered by two clients;
- no application screen has been copied;
- Web behavior and routes remain unchanged.

### 057.3 — Local App Server supervision and capability handshake

Wire Desktop main to start and stop a loopback local LegionCode App Server.

Add only:

- process supervision;
- ephemeral port and per-launch credential kept in Electron main; the renderer
  receives only typed environment status and a restart action;
- initialize/version/capability handshake through the App Server client;
- readiness, restart, crash, incompatibility, and clean-shutdown states;
- shared UI environment status surface used by Desktop and Web.

Exit gate:

- Desktop displays a truthful local-environment ready/degraded/offline state;
- killing the host cannot create a fake terminal event or hanging spinner;
- Web continues to use hosted composition through the same client contract.

### 057.4 — Local workspace selection and durable grant

Add one typed native folder picker and one local workspace grant flow.

The user can:

- select a directory;
- explicitly grant it to the local host;
- see repository identity, branch, readiness, and capabilities;
- revoke the grant;
- reopen the same authorized workspace after restart.

The renderer never receives broad filesystem APIs. The local host validates
canonical paths, traversal, symlinks, repository boundaries, and revocation.

Exit gate: select workspace -> restart Desktop -> reopen the same granted
workspace without a cloud account.

### 057.5 — Local thread list, creation, and replay

Extract the minimum reusable thread/sidebar read model when Desktop becomes its
second consumer.

Add local durable storage through the canonical event/projection repositories:

- list/create/open/rename/archive a local Thread;
- associate it with one local Workspace;
- restart Desktop and reproduce the identical projection;
- make local-only status explicit;
- keep localStorage/sessionStorage limited to disposable UI preferences.

Exit gate: clearing renderer storage cannot delete, create, resurrect, or
reorder a product Thread.

### 057.6 — Local provider and LegionCode native turn

Implement the smallest complete local agent loop:

- configure one provider through OS-protected credential storage;
- select one supported model;
- create a Turn;
- run the LegionCode native harness against the selected local Workspace;
- stream canonical lifecycle items;
- request and settle approvals;
- interrupt cleanly;
- persist terminal outcome;
- restart and replay the same result.

Use existing runtime kernel, permission policy, provider, worker, Git, and event
contracts. Do not create Desktop variants.

Exit gate: prompt -> inspect/read -> approved edit -> test -> final response ->
restart -> identical replay.

### 057.7 — Local artifact, diff, review, and Git completion

Add:

- canonical baseline/final capture;
- immutable completed-turn diff;
- changed-file and artifact review;
- explicit live-workspace review as a different scope;
- commit through the canonical Git service;
- cancellation and failure artifact settlement.

Extract shared review UI only as Desktop consumes each real path.

Exit gate: completed review remains identical after additional unrelated local
Git changes and after app restart.

### 057.8 — Desktop local golden loop and distributable beta

Harden the complete local-only path:

- first launch;
- workspace grant;
- provider setup;
- Thread/Turn;
- approval;
- edit/test;
- interrupt/failure;
- final response;
- diff/review;
- commit;
- restart/replay;
- diagnostics and recovery;
- installer update/rollback strategy.

Run security, performance, accessibility, packaging, and clean-machine tests.

Exit gate: a new user on the primary OS can download LegionCode Desktop and
complete the golden loop without an account or cloud service.

## 8. Relationship To Plan 056

Plan 057 changes the execution order, not Plan 056's desired ownership.

Required order, with the 2026-11-06 subscription parallelization addendum:

1. Plan 056 current-path characterization may complete.
2. Plan 057.1 ships the independent Desktop shell.
3. Plan 057.2 begins shared UI extraction with two real consumers.
4. Preserve merged 057 work and reuse Plan 058's reviewed Web-first
   extractions/hosted-authority slices. The 2026-10-10 serial sequencing is
   narrowed by the user's 2026-11-06 request: Mac work may proceed in parallel,
   waiting for the exact shared boundary it consumes rather than all of 058.
5. Plan 057 completes its accountless local golden loop over those shared
   boundaries. Plan 056 retains broader responsive Web acceptance.
6. Plans 048/061 independently integrate Codex, Claude Agent and OpenCode v2
   locally and in cloud. Neither waits for 057, 058, the Native golden loop or
   another driver. Each slice wires and proves its required canonical services;
   Desktop consumes those integrations and retains installed-app acceptance.
7. Plans 032 and 048 own optional account pairing, connected-local projection,
   remote transports, synchronization, and explicit environment handoff.
8. Plans 045, 047, and 056 own managed-cloud convergence; cloud is not allowed
   to pull shared logic back into Brain or Web.

Plan 058 permits one immediately wired Web consumer per small extraction;
Desktop compilation must remain healthy. Do not perform a bulk `apps/web` move
or native runtime work in 058. All 056/057 acceptance requirements remain;
neither parent is complete through this sequencing change.

### 8.1 Explicit downstream ownership

The [ACP versus native decision](../../../architecture/HARNESS-TRANSPORT-DECISION.md)
fixes the same Codex app-server, Claude Agent SDK and native OpenCode v2 driver
packages for both placements. Mac cloud uses the hosted SDK/App Server and
reopens the same cloud Thread as Web. Mac local uses its local App Server and
Mac-owned repository, persistence and credentials. The environment picker does
not migrate an active attempt or publish a local login. Installed harness
acceptance must exercise Mac/cloud as well as Mac/local; no adapter is copied
into Electron and no new Desktop runtime/store is introduced. Plan 057's local
golden-loop completion remains separately defined below.

| Capability | Executable owner | Entry gate |
| --- | --- | --- |
| Local Codex/Claude/OpenCode v2 integration | Plan 048 | Own SDK/App Server/runtime conformance; wires missing capabilities without a 057/058/other-driver predecessor |
| Cloud Codex/Claude/OpenCode v2 integration | Plan 061 | Own cloud isolation/lifecycle and applicable provider-access proof; no Desktop/Web or other-driver completion gate |
| Installed Mac harness feature, cloud and local | Plan 057 consuming 048/061 | Packaged proof for each advertised driver/placement; cloud reopens Web's hosted Thread; separate from integration implementation |
| Optional login and local-host pairing | Plans 032/048 | Local-only remains functional without an account |
| Web/mobile projection of a local Thread | Plans 032/048/056 | Pairing, authorization, snapshot, and continuation conformance pass |
| Cross-environment continuation | Plans 032/047/048 | Explicit repository/materialization and run-lease handoff exists |
| Managed cloud convergence | Plans 045/047/056 | Local and hosted compositions pass the same SDK/App Server conformance |

The user-facing promise is:

> View any synchronized Thread from any authorized client. Continue it only in
> an online, authorized, compatible environment through an explicit handoff.

Plan 057 makes no broader portability promise.

## 9. PR Size And Demoability Rules

1. One PR owns one user-visible vertical responsibility.
2. Prefer several coherent commits over one large commit.
3. File count is a review heuristic, not an architecture target.
4. A mechanical move may touch many import paths but must be isolated from
   behavioral changes.
5. Every extracted module must have a real Web or Desktop consumer in the same
   PR.
6. Every removed path must have its replacement wired before deletion.
7. Do not land disabled production code waiting for a future phase.
8. Do not maintain two copies of a component or state machine during a long
   migration.
9. Temporary parallel wiring may exist only inside one PR, with parity tests
   and deletion before merge.
10. Every PR description includes a short recorded or reproducible demo path.

### 9.1 Extreme simplicity rule

Every Plan 057 change must be understandable by following one obvious path from
the user action to the result.

1. Do not add empty directories, `.gitkeep` placeholders, speculative package
   skeletons, or files reserved for a later phase.
2. Do not add a framework, registry, factory, provider system, generic base
   class, contract layer, adapter layer, or port unless the current PR has a
   real use that cannot be expressed more clearly with a small function or
   direct dependency.
3. One App Server and one SDK are enough. Add no parallel client runtime,
   protocol client, session host, or compatibility facade.
4. Prefer one plain module with explicit inputs and outputs over several
   abstract interfaces.
5. Create an interface only for a real security/process boundary or when two
   active implementations must be substituted today.
6. Keep functions short, names literal, control flow visible, and state
   explicit. A reviewer should be able to explain the change in ordinary
   language without learning a new internal vocabulary.
7. Do not add tests for pass-through functions, type declarations, framework
   behavior, getters/setters, static markup, or implementation details.
8. Add only the smallest high-signal test that proves a real regression risk,
   security boundary, lifecycle invariant, or vertical acceptance path.
9. Do not create test-only contracts, fake frameworks, broad fixture systems,
   or helper abstractions for one test. Prefer a direct fixture local to the
   test.
10. A PR that adds more architecture than user-visible capability must be
    reduced before review.
11. If a new file, abstraction, or test cannot state the current failure it
    prevents in one sentence, do not add it.
12. Delete obsolete scaffolding and duplicated paths as soon as their simple,
    wired replacement is proven.

## 10. Required Gates

### Every Desktop slice

- Desktop typecheck and unit tests;
- main/preload/renderer boundary tests;
- production packaging smoke test;
- renderer security configuration test;
- no raw Electron/Node APIs exposed to shared UI;
- clean shutdown and no orphan local host process;
- existing focused Web tests for every shared surface touched;
- `git diff --check`.

### Every shared UI/runtime extraction

- Web and Desktop compile from the same shared source;
- parity fixtures or component tests cover both platform adapters;
- no imports between app directories;
- no platform checks scattered through shared presentation;
- keyboard, focus, zoom, reduced-motion, and viewport behavior remain valid;
- current Web behavior is characterized before movement.

### Local golden loop

- no LegionCode account or cloud service required; network access to the
  user's chosen inference provider is allowed;
- local server binds loopback by default;
- path traversal and symlink escape tests;
- provider secrets use OS-protected storage and remain redacted;
- approval cannot be bypassed by renderer or adapter;
- interruption cancels execution and settles one terminal outcome;
- restart produces identical Thread/Turn/artifact projection;
- completed review reads immutable artifacts rather than current Git state.

## 11. Non-Goals

- copying the current Web tree into Desktop;
- loading the hosted production Web URL in the Electron production window;
- moving all Web components into a shared package at once;
- a second Desktop lifecycle, SDK, protocol, provider store, or session store;
- a separate `client-runtime`, `app-server-client`, or public
  `app-server-protocol` package without an independently proven consumer;
- cloud infrastructure migration before a touched vertical slice requires it;
- Tailscale, SSH, relay, mobile, or collaboration before local-only works;
- supporting every OS in the first downloadable slice;
- external harness attachment; Plan 048 owns local adapters through the
  matching native capability gates and Plan 061 owns cloud adapters;
- connected-local account pairing, Web projection, or cross-device sync;
- managed-cloud reattachment or billing changes;
- supporting every provider before one native local golden loop;
- silently synchronizing or merging local-only data into an account;
- silently moving an active Run Attempt between environments;
- treating a folder skeleton or package build as product integration.

## 12. Completion Standard

Plan 057 is complete only when:

1. a user can download and run LegionCode Desktop on the primary supported OS;
2. the complete local golden loop works without login or cloud dependency;
3. Desktop renderer and Web use the same shared UI/SDK source for every
   migrated capability without app-to-app imports;
4. Electron privileges remain behind a typed, validated preload boundary;
5. Desktop uses the same SDK/App Server and canonical lifecycle/artifact model
   as Web;
6. the LegionCode native harness completes prompt, approval, edit, test,
   interrupt, final response, immutable review, Git completion, and restart
   replay locally;
7. local-only mode requires no LegionCode account, cloud database, cloud
   worker, relay, billing service, or public endpoint; network access to the
   user's chosen inference provider is allowed;
8. every intermediate PR remains demoable and every replaced duplicate owner
    is deleted only after its replacement is proven.
