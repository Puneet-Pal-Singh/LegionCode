# @legioncode/execution-engine

Execution runtime package for LegionCode.

## What It Is

`@legioncode/execution-engine` is the runtime orchestration layer that turns a
chat request into a bounded execution loop. It is the package that:

- tracks `runId`-scoped execution state,
- decides when to continue or stop a run,
- records tool lifecycle and recovery metadata,
- builds the runtime context passed to the coding agent,
- coordinates the canonical tool surface used by Brain and the web app.

It is not the sandbox itself and it is not the GitHub API client. It is the
runtime coordinator that sits between planning, tool selection, and execution.

## What It Contains

Two layers are exported:

- Core engine package APIs (`types`, `core`, `tools`, `events`, `observability`, `artifacts`, `pricing`, `cost`).
- Extracted Brain runtime surface under `runtime`:
  - `engine`
  - `run`
  - `task`
  - `state`
  - `orchestration`
  - `planner`
  - `agents`
  - `llm`
  - `cost`

The runtime folder contains the pieces that matter most for day-to-day agent
execution:

- `engine/`: run lifecycle, continuation, recovery, and bounded tool loop
- `agents/`: runtime-facing agent wrappers and task routing
- `contracts/`: canonical tool definitions and validation
- `events/`: activity projection and tool lifecycle event shaping
- `lib/`: execution helpers such as tool presentation and shell normalization
- `run/` and `task/`: persistence entities and repositories

## How It Differs From Shell

There are two different layers in the overall system:

1. `execution-engine`
   This package decides what action should run and records what happened.

2. shell execution
   Shell is only one possible tool path used to run a generic command inside the
   workspace.

That means shell is a tool, but `execution-engine` is the orchestration system
around the tools.

In practice:

- `execution-engine` owns continuation, recovery, activity metadata, and tool
  contracts.
- shell owns raw command execution like `npm test`, `ls`, or one-off commands
  that do not have a safer dedicated tool.

## Why Git Uses The Internal Git Plugin Instead Of Shell

We intentionally prefer the dedicated git path for branch, stage, commit, push,
pull, and PR flows.

The canonical path is:

`execution-engine` -> Brain `ExecutionService` -> secure-agent-api git plugin -> sandbox git CLI

We do not default to raw shell for git because the git path needs stronger
guarantees than a generic `bash -lc "..."` string can provide.

The dedicated git path gives us:

- typed arguments instead of fragile shell strings
- safer validation for paths, refs, and payload size
- cleaner token injection for authenticated GitHub operations
- better activity metadata for the UI
- better continuation recovery because branch/commit/push state is structured
- clearer user-facing errors when a git step fails

Shell is still useful, but it is the fallback for generic workspace commands,
not the canonical path for git workflows.

## Why Hybrid Wins

The best long-term product shape is not "plugin only" or "shell only". It is a
hybrid model:

- use dedicated plugins for high-value, repeatable workflows where the product
  should understand the action,
- use shell for open-ended commands where flexibility matters more than
  structured recovery.

This matters even more as LegionCode expands to desktop use.

Why plugins scale well:

- security is easier to enforce with typed inputs and narrower permissions,
- telemetry is cleaner because the runtime understands the exact action,
- recovery is better because continuation state is structured,
- support and debugging are easier because failures map to known steps.

Why shell still matters:

- users need freedom for arbitrary local development commands,
- not every workflow deserves a first-class product abstraction,
- power users expect terminal-like behavior for exploration and one-off tasks.

The risk is not that the git plugin exists. The real risk would be forcing all
workflows through plugins and removing shell flexibility. The current design
tries to avoid that mistake:

- plugin-first for canonical git and GitHub workflows,
- shell available as the escape hatch for general development work.

For LegionCode, that means git durability and predictable recovery are product
advantages, not scaling drawbacks, as long as shell remains available for the
long tail of flexible tasks.

## What Shell Contains

The shell path is best for commands such as:

- package manager and test commands
- build or lint commands
- repo inspection that truly needs a command-line tool
- machine-like workflows that do not yet have a dedicated structured tool

Examples:

- `pnpm test`
- `npm run lint`
- `rg "pattern" src`

Examples that should prefer dedicated tools instead of shell:

- creating a branch
- staging files
- creating a commit
- pushing a branch
- opening a pull request through the run-aware GitHub flow

## Why Continuation Reliability Depends on This

Recent runtime fixes depend on this distinction.

When git runs through the dedicated path, the runtime can persist structured
state such as:

- which files were already changed,
- which git steps already succeeded,
- which branch is the active branch for the resumed workspace,
- what the last failed git step actually was.

That is what allows a short follow-up like `continue?` to resume correctly
without rewriting files or guessing at shell commands.

## Import Surface

```ts
import * as ExecutionEngine from "@legioncode/execution-engine";
import { RunEngine, RunRepository, TaskRepository } from "@legioncode/execution-engine/runtime";
```

Brain compatibility wrappers now re-export from `@legioncode/execution-engine/runtime`.

## Development Commands

```bash
pnpm --filter @legioncode/execution-engine type-check
pnpm --filter @legioncode/execution-engine test
pnpm --filter @legioncode/execution-engine build
```

## Extraction Notes (Phase 3.2)

- Runtime modules were moved from `apps/brain/src/core/*` into `packages/execution-engine/src/runtime/*`.
- Migration is extraction-first (move/import rewiring), not rewrite-first.
- Package runtime exports are the intended stable boundary for Phase 4.

## Provider Adapter Boundary

Provider-specific behavior must stay in `src/adapters/*`. Runtime modules under
`src/runtime/*` may only consume provider-neutral contracts.

### Adapter Onboarding (Repeatable Path)

1. Implement a new adapter in `src/adapters/<ProviderName>Adapter.ts` that
   satisfies `ModelProvider`.
2. Register it via `ProviderAdapterRegistry` (from `src/adapters`) using a
   stable lowercase provider id (for example `openai`, `anthropic`, `groq`).
3. Expose adapter metadata through provider-neutral interfaces only
   (`ModelProvider`, registry descriptors), not provider SDK types.
4. Add or update unit/integration tests for the adapter behavior.
5. Run the boundary guard test to verify runtime isolation:
   `pnpm --filter @legioncode/execution-engine test -- tests/unit/runtime-adapter-boundary.test.ts`
