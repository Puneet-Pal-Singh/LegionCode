# Provider Integration Matrix

This document defines provider behavior expectations, ownership, and test coverage mapping for BYOK flows.

## Contract Ownership

- Transport schemas: `packages/shared-types/src/provider.ts`
- Authenticated provider boundary: `apps/brain/src/controllers/AppServerController.ts`
- Hosted provider operations: `apps/brain/src/integration/app-server/`
- Runtime provider behavior: `apps/brain/src/runtime/RunEngineRuntime.ts`
- Runtime selection policy: `apps/brain/src/services/ai/ModelSelectionPolicy.ts`
- Execution lane policy: `apps/brain/src/services/providers/ProviderRegistryService.ts`

## App Server Method Contract Surface

Provider operations are authenticated App Server methods with a canonical run
ID in the request envelope:

- `provider/catalog`, `provider/models`, `provider/models/refresh`
- `provider/credentials/list`, `connect`, `update`, `validate`, `disconnect`
- `provider/preferences/read`, `provider/preferences/update`
- `provider/resolve`

The server derives viewer and workspace from the verified session cookie. No
standalone `/api/byok/*` route is registered.

## Provider Capability Matrix

| Provider      | Connection       | Catalog   | Validate       | Disconnect     | Strict Model Guard |
| ------------- | ---------------- | --------- | -------------- | -------------- | ------------------ |
| axis          | Platform-managed | Supported | Not applicable | Not applicable | Curated            |
| openrouter    | Supported        | Supported | Supported      | Supported      | Enforced           |
| openai        | Supported        | Supported | Supported      | Supported      | Enforced           |
| groq          | Supported        | Supported | Supported      | Supported      | Enforced           |
| anthropic     | Supported        | Supported | Supported      | Supported      | Enforced           |
| google        | Supported        | Supported | Supported      | Supported      | Enforced           |
| together      | Supported        | Supported | Supported      | Supported      | Enforced           |
| cerebras      | Supported        | Supported | Supported      | Supported      | Enforced           |
| mistral       | Supported        | Hidden    | Supported      | Supported      | Enforced           |
| cohere        | Supported        | Hidden    | Not supported  | Supported      | Enforced           |
| opencode-go   | Supported        | Supported | Supported      | Supported      | Enforced           |
| opencode-zen  | Supported        | Supported | Supported      | Supported      | Enforced           |
| cloudflare-ai | Supported        | Supported | Format only    | Supported      | Enforced           |

Axis remains a managed starter provider with curated free models and quota behavior, but its execution-lane admission is still governed by the same capability-driven policy as other providers.

Cohere and Mistral remain hidden from the launch catalog until product support is completed.

OpenCode Go is supported through its OpenAI-compatible chat-completions route. OpenCode Zen is a mixed-transport provider; selectable models must carry explicit runtime route metadata before execution. Cloudflare AI is supported through explicit account route metadata and OpenAI-compatible Workers AI chat-completions routes, either direct or through AI Gateway.

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
| Hosted provider App Server operations    | `apps/brain/src/integration/app-server/HostedProviderOperations.test.ts` |
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
