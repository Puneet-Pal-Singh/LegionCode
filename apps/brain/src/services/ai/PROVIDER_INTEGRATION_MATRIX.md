# Provider Integration Matrix

This document defines provider behavior expectations, ownership, and test coverage mapping for BYOK flows.

## Contract Ownership

- Transport schemas: `packages/shared-types/src/provider.ts`
- Public BYOK API routes: `apps/brain/src/controllers/ProviderController.ts`
- Runtime provider behavior: `apps/brain/src/runtime/RunEngineRuntime.ts`
- Runtime selection policy: `apps/brain/src/services/ai/ModelSelectionPolicy.ts`
- Execution lane policy: `apps/brain/src/services/providers/ProviderRegistryService.ts`

## Endpoint Contract Surface

- `GET /api/byok/providers/catalog`
- `GET /api/byok/providers/connections`
- `POST /api/byok/providers/connect`
- `POST /api/byok/providers/validate`
- `POST /api/byok/providers/disconnect`
- `PATCH /api/byok/preferences`

## Provider Capability Matrix

| Provider      | Connection       | Catalog     | Validate       | Disconnect     | Strict Model Guard |
| ------------- | ---------------- | ----------- | -------------- | -------------- | ------------------ |
| axis          | Platform-managed | Supported   | Not applicable | Not applicable | Curated            |
| openrouter    | Supported        | Supported   | Supported      | Supported      | Enforced           |
| openai        | Supported        | Supported   | Supported      | Supported      | Enforced           |
| groq          | Supported        | Supported   | Supported      | Supported      | Enforced           |
| anthropic     | Supported        | Supported   | Supported      | Supported      | Enforced           |
| google        | Supported        | Supported   | Supported      | Supported      | Enforced           |
| together      | Supported        | Supported   | Supported      | Supported      | Enforced           |
| cerebras      | Supported        | Supported   | Supported      | Supported      | Enforced           |
| mistral       | Supported        | Hidden      | Supported      | Supported      | Enforced           |
| cohere        | Supported        | Hidden      | Not supported  | Supported      | Enforced           |
| opencode-go   | Supported        | Supported   | Supported      | Supported      | Enforced           |
| opencode-zen  | Supported        | Supported   | Supported      | Supported      | Enforced           |
| cloudflare-ai | Coming soon      | Coming soon | Coming soon    | Coming soon    | Enforced           |

Axis remains a managed starter provider with curated free models and quota behavior, but its execution-lane admission is still governed by the same capability-driven policy as other providers.

Cohere and Mistral remain hidden from the launch catalog until product support is completed.

OpenCode Go is supported through its OpenAI-compatible chat-completions route. OpenCode Zen is a mixed-transport provider; selectable models must carry explicit runtime route metadata before execution. Cloudflare AI remains coming soon until account metadata, model discovery, and at least one Workers AI route are wired end to end.

## Execution Lane Policy (Plan 82)

Lane admission is **capability-driven only**. No lane rejection is based on provider ID, model price tier, or reliability classification.

| Lane                           | Required Capabilities                                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `chat_only`                    | Always supported                                                                                                |
| `single_agent_action`          | `capabilities.tools`                                                                                            |
| `structured_planning_required` | `capabilities.tools` + `capabilities.structuredOutputs` + JSON mode or anthropic-native/google-native transport |

`latencyTier` and `reliabilityTier` are **informational only** (telemetry, UI hints). They do not influence lane admission.

## Test Ownership Matrix

| Flow                                     | Primary Test File                                                     |
| ---------------------------------------- | --------------------------------------------------------------------- |
| BYOK controller API surface              | `apps/brain/src/controllers/ProviderController.test.ts`               |
| Provider state contract integration      | `apps/brain/src/integration/provider-state.contract.test.ts`          |
| Strict provider/model mismatch policy    | `apps/brain/src/services/ai/ModelSelectionPolicy.strict-mode.test.ts` |
| Durable credential persistence semantics | `apps/brain/src/services/providers/DurableProviderStore.test.ts`      |
| Execution profile lane admission         | `apps/brain/src/services/providers/ProviderRegistryService.test.ts`   |

## Update Rule

When adding provider capabilities, updating schemas, or changing ownership boundaries:

1. update `packages/shared-types` contracts
2. update this matrix
3. update `provider-integration-matrix.fixture.json`
4. update/extend affected tests in the matrix above
