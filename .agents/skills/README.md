# Shadowbox Agent Skills

This directory contains [Agent Skills](https://agentskills.io/) that extend agent capabilities with specialized knowledge and workflows.

## Available Skills

| Skill                             | Description                                      |
| --------------------------------- | ------------------------------------------------ |
| [git-workflow](./git-workflow/)   | Safe, intentional Git operations                 |
| [pr-workflow](./pr-workflow/)     | Focused pull-request review and publishing       |
| [quality-gates](./quality-gates/) | CI, test-tier, smoke-test, and gate design       |
| [security](./security/)           | Security work at sensitive LegionCode boundaries  |

## Skill Format

Each skill follows the [Agent Skills specification](https://agentskills.io/specification):

```
skill-name/
└── SKILL.md          # Required: YAML frontmatter + instructions
```

## How Skills Work

Skills use **progressive disclosure**:

1. **Discovery**: Agent loads skill name/description at startup
2. **Activation**: Full SKILL.md loaded when task matches
3. **Execution**: Agent follows instructions, loads references as needed

## Policy boundary

[AGENTS.md](../../AGENTS.md) is the single source of repository policy. Keep a
skill procedural, concise, and scoped to one workflow; do not copy policy or
refer to brittle section numbers. Add automation only when it is a reusable
workflow or enforces a repeated/high-severity failure.

## References

- [Agent Skills Website](https://agentskills.io/)
- [Specification](https://agentskills.io/specification)
- [Example Skills](https://github.com/anthropics/skills)
