# @legioncode/sdk

Shared provider client SDK for LegionCode web and desktop cloud-path consumers.

## Purpose

`@legioncode/sdk` is the only client-side transport and orchestration boundary for BYOK/provider operations.

It centralizes:
- typed provider contracts (`@repo/shared-types` + `@repo/provider-core`),
- lifecycle transitions (`discover/connect/validate/select/resolve/disconnect`),
- transport-level error normalization and retryability semantics,
- cross-client parity expectations for web and desktop-cloud clients.

## Terminology

- `ModelProvider`: inference provider only (OpenAI, OpenRouter, Google, Anthropic, etc).
- `TelemetrySink`: analytics/observability provider.
- `RuntimeBackend`: execution backend (`secure-agent-api`, future runtimes).

This package covers `ModelProvider` flows only.

## Public Provider Surface

- `createProviderClient`
- `createByokHttpTransport`
- `createByokCloudTransport`
- `ProviderClient` and related transport/error/state-machine types

Primary files:
- `src/providers/client.ts`
- `src/providers/http-transport.ts`
- `src/providers/cloud-transport.ts`
- `src/providers/errors.ts`
- `src/providers/state-machine.ts`

## Usage

Web client:

```ts
import { createProviderClient, createByokHttpTransport } from "@legioncode/sdk";

const client = createProviderClient(
  createByokHttpTransport({
    baseUrl: `${brainBaseUrl}/api/byok`,
    getRunId: () => runId,
  }),
);
```

Desktop cloud-path client:

```ts
import { createProviderClient, createByokCloudTransport } from "@legioncode/sdk";

const client = createProviderClient(
  createByokCloudTransport({
    baseUrl: `${brainBaseUrl}/api/byok`,
    getRunId: () => runId,
    getAccessToken: () => token,
  }),
);
```

## Ownership Boundaries

Required:
- Route BYOK transport through this SDK only.
- Keep provider DTO validation in shared contracts.
- Keep lifecycle and typed failure semantics in SDK/provider-core boundaries.

Forbidden:
- Direct `fetch("/api/byok/*")` from app UI/store code.
- App-local duplicate provider transport clients.
- App-local redefinition of BYOK/provider DTO schemas.

## Migration Rules

When migrating app-local provider code:

1. Replace direct BYOK HTTP calls with `createProviderClient(...)`.
2. Keep app layers as adapters around SDK APIs only.
3. Preserve typed error handling (`ProviderClientOperationError` -> app error mapping).
4. Remove duplicate path construction/parsing once SDK transport is wired.
5. Add/keep parity tests when changing transport behavior.

## Conformance Expectations

- Web and desktop cloud-path clients must preserve equivalent contract behavior.
- Conformance tests are expected to stay green:
  - `src/providers/cross-client-contract-parity.test.ts`
  - `src/providers/cross-client-lifecycle-parity.test.ts`

## Verification

```bash
pnpm --filter @legioncode/sdk lint
pnpm --filter @legioncode/sdk check-types
pnpm --filter @legioncode/sdk test
```
