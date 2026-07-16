---
name: security
description: Audit or implement LegionCode code that handles secrets, authentication, authorization, external input, filesystem access, network access, approvals, or Git mutations. Use for security reviews, vulnerabilities, and sensitive-boundary changes.
---

# Security workflow

Start with a threat model for the changed boundary: actor, asset, entry point,
trust transition, and intended permission decision. Follow `AGENTS.md` security
and runtime ownership rules.

## Inspect

- Validate untrusted input with the canonical schema or Zod at the boundary.
- Trace filesystem paths to the supplied workspace/root and reject traversal.
- Verify authentication and authorization before access, with deny-by-default
  behavior for missing or malformed permission state.
- Ensure approval-sensitive actions use typed approval policy rather than UI or
  adapter guesses.
- Check logs, errors, fixtures, docs, and diffs for secrets, tokens, cookies,
  PII, and unsafe command construction.
- Review dependency changes and lockfile changes for their direct impact.

## Verify and report

Add or run tests at the authorization, validation, or policy boundary. Report
findings by severity with evidence, exploit path, impact, and a minimal safe
fix. Never automatically run dependency upgrade or remediation commands that
change the lockfile; explain the proposed change and obtain authority first.
