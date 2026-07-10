# AGENTS.md

# LegionCode Agent Operating Constitution

This file is the repo-wide truth file for agents working on LegionCode.

It defines how agents must behave, how code should be shaped, what architecture
the product is moving toward, and what quality bar every change must meet. It is
not a status report. It is the operating law.

---

## 1. Product Truth

LegionCode is an OSS AI coding-agent workspace.

The product must support:

- Web cloud sandbox execution.
- Desktop local execution.
- CLI and mobile later.
- Public `@legioncode/sdk`.
- ACP, Codex SDK, OpenCode, Claude Code, and Cursor-style harness adapters.
- BYOK and provider catalog support.
- One canonical runtime/workflow/review architecture shared by all clients.

The goal is one kernel, one protocol, one event log, one workspace manifest, one
Git owner, and many thin clients.

Do not optimize for one temporary UI screen if it damages the future
SDK/desktop/runtime architecture.

---

## 2. Canonical Mental Model

Use these nouns consistently:

- **Workspace**: repo/environment boundary.
- **Thread/Session**: durable user conversation.
- **Turn**: one user request and assistant response lifecycle.
- **Run Attempt**: one execution attempt for a turn.
- **Tool Call**: auditable action inside a run attempt.
- **Approval**: explicit permission decision.
- **Artifact/Diff**: canonical output of a completed turn.
- **Lifecycle Event**: append-only source of truth.
- **Projection**: derived read model only.

Forbidden confusion:

- Do not collapse thread, turn, run, and tool call into one id.
- Do not make Web infer runtime truth.
- Do not let projections mutate source-of-truth state.
- Do not use live Git as completed-turn review truth.
- Do not treat localStorage as product persistence.

---

## 3. Source-Of-Truth Rules

1. Runtime is the only producer of canonical turn/tool/approval/artifact/final
   lifecycle events.
2. The same append path must persist and emit live continuation.
3. Web/Desktop/CLI render SDK replay plus live continuation.
4. Run summary is a projection.
5. Activity feed is a projection.
6. localStorage is only a UI preference/cache layer.
7. Review/diff comes from canonical turn diff/artifact projection.
8. Approval request, decision, settlement, and terminal turn settlement are
   typed lifecycle events.
9. Failed, cancelled, interrupted, and timed-out turns settle explicitly.
10. Stop/interrupt is a runtime command that emits terminal lifecycle state.

If two modules can both decide the same product state, the architecture is
wrong.

---

## 4. Architecture-First Bug Fixing

Do not patch symptoms on broken lifecycle/runtime/product flows.

When fixing workflow, tool calls, execution, persistence, approval, review/diff,
Git, provider routing, runtime state, or SDK boundaries:

1. Trace the full lifecycle of the feature.
2. Identify every owner/source of truth.
3. Delete competing owners.
4. Make the canonical owner explicit.
5. Add the smallest high-signal gate that proves the complete lifecycle.
6. Research Codex, OpenCode, and T3 Code when architecture is unclear.
7. Adapt the good pattern to LegionCode boundaries; do not blindly copy.

Required stance:

- Delete bad code more.
- Delete bad patterns more.
- Delete fallbacks.
- Delete duplicate authorities.
- Implement good patterns.
- Divide god files into smaller helper files using SRP, KISS, DRY, SOLID, and
  strong package boundaries.

Deletion-biased stabilization PRs are good. Major cleanup PRs may look like
`1250+ / 6500-`. Do not remove healthy code just to hit numbers; the point is
architectural simplification.

---

## 5. Core Engineering Principles

### SOLID

- **Single Responsibility**: one module, class, function, or hook should have
  one reason to change.
- **Open/Closed**: extend through interfaces, registries, and adapters; avoid
  modifying central switchboards for every new provider/tool/client.
- **Liskov Substitution**: implementations must honor their interface
  contracts. No surprise `null`, missing fields, or partial behavior.
- **Interface Segregation**: prefer narrow ports over giant service interfaces.
- **Dependency Inversion**: high-level policy depends on abstractions, not
  concrete SDKs, fetch calls, or filesystem implementations.

### DRY

- Do not duplicate lifecycle state machines, approval logic, tool schemas, Git
  parsing, provider routing, or diff selection.
- Shared behavior used by two clients belongs in a package or shared service,
  not copied into Web/Desktop/Brain separately.

### KISS

- Prefer obvious code over clever code.
- Prefer explicit state machines over boolean soup.
- Prefer typed errors over magical recovery.
- Prefer small adapters over broad abstraction frameworks.

### OOP And Composition

- Use objects/classes when they model long-lived collaborators with state or
  ports.
- Prefer composition over inheritance.
- Avoid god services that know every subsystem.
- Inject dependencies at boundaries so tests and local/cloud backends can swap
  implementations.

### YAGNI

- Do not build future harnesses, mobile, hooks, or provider features until the
  canonical runtime path is stable.
- Add extension points only when they remove real duplication or match an
  already-needed integration.

### Law Of Demeter

- Modules should talk to their direct collaborators only.
- Web should not reach into persistence/runtime internals.
- Brain should not know filesystem execution details.
- Adapters should not own lifecycle, Git, approval, or persistence truth.

### Type And Schema Discipline

- Avoid `any`; use `unknown` plus narrowing.
- Validate external input with Zod or canonical protocol schemas.
- Use discriminated unions for lifecycle/status states.
- Use branded/canonical ids where available.
- Do not pass raw strings for important ids when a schema/type exists.

---

## 6. Compatibility And Fallback Policy

Default to forward-only behavior.

- No silent fallback paths.
- No compatibility layers unless explicitly requested.
- No "just in case" dual paths.
- No local UI guessing when canonical lifecycle exists.
- No legacy API path in active product flow unless explicitly quarantined.

If a fallback/compatibility path must remain temporarily, the PR must state:

1. owner,
2. reason,
3. canonical replacement,
4. deletion trigger,
5. test/gate that will prove it can be removed.

---

## 7. God File Policy

A god file is any file where one change requires understanding unrelated
concerns, or where the file is large enough that agents repeatedly break it.

Known high-risk files include, but are not limited to:

- `packages/execution-engine/src/runtime/engine/AgenticLoopToolExecutor.ts`
- `packages/execution-engine/src/runtime/tools/CodingToolRegistry.ts`
- `packages/execution-engine/src/runtime/engine/RuntimeKernelNativeRunner.ts`
- `apps/brain/src/runtime/RunEngineRequestHandler.ts`
- `apps/brain/src/services/ExecutionService.ts`
- `apps/web/src/components/chat/ChatInputBar.tsx`
- `apps/web/src/components/chat/ChatMessage.tsx`
- `apps/web/src/services/workflow/WorkflowTimelineViewModel.ts`

When touching a god file:

1. Extract the touched responsibility into a focused helper/module.
2. Preserve behavior unless intentionally deleting bad behavior.
3. Add or keep tests around the extracted boundary.
4. Do not perform unrelated broad rewrites.

---

## 8. Package And Boundary Rules

The ideal dependency direction:

```txt
clients -> platform-client-sdk -> platform-protocol
clients -> runtime adapters -> runtime-kernel
runtime-kernel -> worker-protocol / permission-policy / git-service
brain -> control-plane services -> runtime backend ports
persistence -> event/projection repositories
```

Rules:

- Public clients should use SDK/protocol packages, not app internals.
- Runtime execution must sit behind ports.
- Tool execution must use registry/policy metadata.
- Git mutations must use canonical Git services/tools.
- Provider/model behavior belongs in provider packages/services/catalogs.
- Brain is control plane; runtime owns workspace/git/tools/events.
- Web is a client; it does not own canonical runtime state.

---

## 9. Code Smells To Delete

- Multiple sources of truth.
- Silent catch blocks.
- Boolean soup for lifecycle state.
- UI-owned runtime state.
- localStorage as product state.
- Live Git as completed-turn review truth.
- Controller files containing business logic.
- Tool execution outside registry/policy.
- Hardcoded provider/model/tool behavior.
- Legacy "temporary" paths without deletion criteria.
- Repeated parser/string manipulation where typed APIs exist.
- Large React components doing data orchestration.
- Large services mixing auth, execution, persistence, Git, and logging.

---

## 10. Testing And Gates

Test where the risk lives.

- Unit tests for pure reducers, schemas, policies, and view-model builders.
- Contract tests for SDK/protocol/runtime boundaries.
- Integration tests for persistence and runtime ports.
- Product E2E tests for prompt -> workflow -> approval -> tool -> final ->
  review diff -> reload/replay.

Do not add low-value tests for trivial pass-through code.

Important commands:

```bash
corepack pnpm --filter @shadowbox/web test
corepack pnpm --filter @shadowbox/web check-types
corepack pnpm --filter @shadowbox/brain test
corepack pnpm --filter @shadowbox/brain check-types
corepack pnpm --filter @shadowbox/execution-engine test
corepack pnpm --filter @shadowbox/execution-engine type-check
corepack pnpm gate:golden-repo-to-pr
```

If a command fails because a package/script name changed, inspect
`package.json` and run the correct equivalent.

---

## 11. Git And Multi-Agent Safety

- Do not create/switch branches unless explicitly requested.
- Do not create/apply/drop stash entries unless explicitly requested.
- Do not create/remove/modify worktrees unless explicitly requested.
- Never use `git reset --hard` or destructive checkout commands unless the user
  explicitly requests that exact operation.
- Never use `git add -A` or `git add .`; stage specific files.
- Use conventional commits:
  - `fix(scope): summary`
  - `feat(scope): summary`
  - `refactor(scope): summary`
  - `test(scope): summary`
  - `docs(scope): summary`
- Keep commits atomic.
- For shared/reviewed branches, prefer merge over rebase.
- Rebase only private unpushed cleanup branches.
- When seeing unfamiliar changes, assume another agent/user made them and work
  around them. Do not revert unrelated changes.

### Worktree Hygiene

Avoid putting worktrees inside the repo root. If `.worktrees/` exists, scans and
scripts must prune it along with `node_modules`, `dist`, `.turbo`, and generated
artifacts.

---

## 12. Skills

Use repo skills when the task matches them:

- `.agents/skills/git-workflow`: safe git operations.
- `.agents/skills/security`: security audits and vulnerability scanning.
- `.agents/skills/pr-workflow`: PR creation, review, and merge workflow.

Do not invent tool names from old docs. Use the tools actually available in the
current environment. If a requested skill/tool is unavailable, say so and use
the safest available equivalent.

---

## 13. PR Checklist And Documentation

Follow the PR workflow skill:

- `.agents/skills/pr-workflow`

Every implementation PR should clearly state:

1. Objective.
2. Architecture decision.
3. Files changed.
4. Tests/gates run.
5. Risks.
6. Rollback/recovery notes if relevant.
7. Any fallback/legacy path kept and its deletion trigger.

Documentation rules:

- Do not create completion summaries, handoff docs, or extra markdown files
  unless explicitly requested.
- PR descriptions are the source of truth for implementation summaries.
- `local/` is for private findings, audits, handoffs, and scratch material.
- `plans/` is for planning. Many plan files may be intentionally ignored.
- If closing an architecture red flag, update:
  `local/findings/2026-07-03-ARCHITECTURE-RED-FLAG-TRACKER.md`.

---

## 14. Security And Secrets

- Never log secrets, API keys, OAuth tokens, cookies, or PII.
- Never commit `.env`, `.dev.vars`, key files, or credentials.
- Validate filesystem paths against traversal.
- Scope file operations to the workspace/root/cwd supplied by the runtime.
- Permission-sensitive actions must flow through typed approval policy.
- GitHub/Git mutations must use canonical git services/tools, not ad hoc shell
  commands, unless explicitly routed through the approved execution boundary.

---

## 15. Review Checklist

Before declaring work complete:

1. Did I remove competing sources of truth instead of adding another patch?
2. Did I delete bad fallback/legacy code where possible?
3. Did I avoid `any` and validate external inputs?
4. Did I apply SOLID, DRY, OOP, KISS, and package-boundary discipline?
5. Did I extract touched god-file responsibilities?
6. Did I preserve or improve the product path?
7. Did I run the smallest meaningful tests/typechecks?
8. Did I update the red-flag tracker if a listed gap changed?
9. Did I avoid touching unrelated user/agent work?
10. Can Web/Desktop/SDK/ACP use the resulting boundary more easily?

If the answer to 1 or 6 is "no," the fix is probably a bandage, not a fix.
