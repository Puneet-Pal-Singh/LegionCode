# Shadowbox Agent Configuration

This directory contains agent-specific configuration and skills.

## Structure

```
.agents/
├── skills/           # Agent Skills (https://agentskills.io/)
│   ├── git-workflow/
│   ├── pr-workflow/
│   ├── quality-gates/
│   └── security/
│   └── README.md
└── README.md         # This file
```

## Agent Skills

Agent Skills extend agent capabilities with specialized knowledge. See [.agents/skills/README.md](./skills/README.md) for details.

## Core Documentation

- [AGENTS.md](../AGENTS.md) - Main agent constitution and guidelines

`AGENTS.md` is the sole repository policy. Skills hold focused procedures and
must not restate or override it.

## Supported Agents

These skills work with any Agent Skills-compatible tool including:

- Claude Code
- Claude.ai
- OpenCode
- Cursor
- And more (see https://agentskills.io/)
