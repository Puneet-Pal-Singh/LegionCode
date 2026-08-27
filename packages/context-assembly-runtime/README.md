# @legioncode/context-assembly-runtime

Minimal implementation of the Context Assembly Engine.

## Overview

This package provides a working implementation of the Context Assembly interfaces defined in `@legioncode/context-assembly`. It assembles LLM context from:

- System prompts
- Repository files
- Git diffs
- Runtime events

## Philosophy

**v1 = Minimal, Deterministic, Pure**

- Simple character-based token counting
- Fixed assembly order
- Hard budget enforcement
- No optimization
- No strategies
- No summarization

## Installation

```bash
pnpm add @legioncode/context-assembly-runtime
```

## Usage

```typescript
import { ContextBuilder } from "@legioncode/context-assembly-runtime";
import type { ContextBuildInput } from "@legioncode/context-assembly";

const builder = new ContextBuilder();

const context = await builder.build({
  runId: "session-123",
  goal: { raw: "Implement feature X" },
  agent: {
    id: "coder-1",
    role: "coder",
    capabilities: ["read_files", "write_files", "search"],
  },
  repo: {
    root: "/workspace/project",
    files: [{ path: "src/index.ts", size: 1024, content: "..." }],
  },
  constraints: {
    maxTokens: 10000,
    strategy: "balanced",
    allowSummarization: false,
  },
});

// context.system - System prompt string
// context.messages - Array of context messages
// context.tools - Available tool descriptors
// context.tokenEstimate - Estimated token count
// context.debug - Debug information
```

## API

### ContextBuilder

Main class for building context bundles.

```typescript
const builder = new ContextBuilder(options?: {
  tools?: ToolDescriptor[];
  charsPerToken?: number;
});

const bundle = await builder.build(input: ContextBuildInput): Promise<ContextBundle>;
```

### TokenCounter

Simple character-based token estimation.

```typescript
const counter = new TokenCounter(charsPerToken?: number);
const tokens = counter.count(text: string): number;
const total = counter.countBatch(texts: string[]): number;
```

### Assemblers

Dumb transformation functions that convert input data to context messages.

```typescript
import { assembleSystem } from "@legioncode/context-assembly-runtime";
import { assembleHistory } from "@legioncode/context-assembly-runtime";
import { assembleRepo } from "@legioncode/context-assembly-runtime";
import { assembleDiffs } from "@legioncode/context-assembly-runtime";
import { assembleEvents } from "@legioncode/context-assembly-runtime";
```

### Formatters

Pure string serializers for converting data structures to strings.

```typescript
import { formatFile, formatFiles } from "@legioncode/context-assembly-runtime";
import { formatDiff, formatDiffs } from "@legioncode/context-assembly-runtime";
import { formatEvent, formatEvents } from "@legioncode/context-assembly-runtime";
```

## Assembly Order

1. **System Prompt** - Never dropped
2. **History** - Conversation history from memory
3. **Repository Files** - Explicitly passed files
4. **Git Diffs** - Uncommitted changes
5. **Runtime Events** - Tool calls, errors, results (dropped first if over budget)

## Token Budget

Simple character-based estimation (4 characters ≈ 1 token).

When over budget, sections are dropped in priority order:

1. Runtime events (lowest priority)
2. Git diffs
3. Repository files
4. Old history
5. System prompt (NEVER)

## Architecture

```text
packages/context-assembly-runtime/
├── src/
│   ├── index.ts                    # Public API exports
│   ├── ContextBuilder.ts           # Main implementation
│   ├── TokenCounter.ts             # Token estimation
│   ├── TokenBudget.ts              # Budget tracking
│   ├── assemblers/
│   │   ├── SystemAssembler.ts      # System prompt
│   │   ├── HistoryAssembler.ts     # Memory/history
│   │   ├── RepoAssembler.ts        # Repository files
│   │   ├── DiffAssembler.ts        # Git diffs
│   │   └── EventAssembler.ts       # Runtime events
│   └── formatters/
│       ├── FileFormatter.ts        # File serialization
│       ├── DiffFormatter.ts        # Diff serialization
│       └── EventFormatter.ts       # Event serialization
└── tests/
    ├── TokenCounter.test.ts        # Token counter tests
    └── ContextBuilder.test.ts      # Builder tests
```

## Constraints

This implementation follows strict constraints:

- **No interface changes** - Uses only Task 0 interfaces
- **No strategy implementations** - Fixed assembly order
- **No summarization logic** - Pure transformations only
- **No vendor SDK dependencies** - Pure TypeScript
- **No multi-agent logic** - Single agent focus

## Next Steps

Future iterations may include:

- Improved token estimation (tiktoken integration)
- Multiple assembly strategies
- Content summarization
- Multi-agent context sharing
- Streaming support

## License

Private - LegionCode project
