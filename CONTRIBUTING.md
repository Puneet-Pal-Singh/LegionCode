# Contributing to LegionCode

Thanks for contributing. This document defines the expected local workflow and quality gates.

## Prerequisites

- Node.js `>=18`
- pnpm `>=9`
- GitHub CLI (optional, for PR workflow)

## Local Setup

```bash
pnpm install
pnpm dev
```

Run app-specific dev servers:

```bash
pnpm --filter @legioncode/web dev
pnpm --filter @legioncode/brain dev
pnpm --filter @legioncode/secure-agent-api dev
```

## Required Quality Checks

Run these before opening a PR:

```bash
pnpm lint
pnpm check-types
pnpm check:boundaries
pnpm --filter @legioncode/web test -- --run
pnpm --filter @legioncode/brain test
pnpm --filter @legioncode/secure-agent-api test
pnpm --filter @legioncode/execution-engine test
pnpm build
```

## Branching and Commits

- Use a dedicated branch per logical change.
- Use semantic branch names:
  - `feat/<scope>-<intent>`
  - `fix/<scope>-<intent>`
  - `refactor/<scope>-<intent>`
  - agent branches use `codex/<type>-<scope>-<intent>`
- Use conventional commits:
  - `feat:`
  - `fix:`
  - `refactor:`
  - `test:`
  - `docs:`
  - `chore:`
- Keep commits atomic and auditable.

## Pull Requests

- Keep scope focused to one logical change set.
- Include what changed, why it changed, and how it was validated.
- Link architecture decisions and docs when behavior or boundaries change.

## Security and Secrets

- Never commit `.env`, `.dev.vars`, API keys, or tokens.
- Follow `SECURITY.md` for reporting and handling vulnerabilities.
