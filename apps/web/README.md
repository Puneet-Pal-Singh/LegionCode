# LegionCode Web App (Agents Workspace)

Frontend for the LegionCode agents workspace. After the landing
extraction (plan 018), this app is the authenticated product surface
only — the public marketing site lives in `apps/landing` and is
served from `legioncode.dev`. The web app is served from
`agents.legioncode.dev`.

## Stack

- React 19
- TypeScript
- Vite
- Tailwind CSS v4

## Local Development

From the repository root:

```bash
pnpm --filter @shadowbox/web dev
```

The web app dev server binds to port `5174` with `strictPort: true`.
The landing app (`apps/landing`) dev server binds to `5173` and
proxies `/agents/*` to this port, so a single origin serves both
surfaces in dev. See `apps/landing/vite.config.ts` for the port
contract.

## Build

```bash
pnpm --filter @shadowbox/web build
```

For staging or production-like deploys, use the deploy build instead:

```bash
pnpm --filter @shadowbox/web build:deploy
```

## Quality Checks

```bash
pnpm --filter @shadowbox/web lint
pnpm --filter @shadowbox/web check-types
pnpm --filter @shadowbox/web test -- --run
```

## Environment Configuration

Expected environment variables:

- `VITE_BRAIN_BASE_URL`
- `VITE_MUSCLE_BASE_URL`
- `VITE_MUSCLE_WS_URL`

If values are not set in development, local defaults are used and warnings are emitted by `src/lib/platform-endpoints.ts`.
Deploy builds fail fast when any of the required `VITE_*` endpoint variables are missing.

## Launch Posture

LegionCode is currently shipped as **Public Alpha**.

Recommended public copy:

> LegionCode is in public alpha. Expect rough edges, fast changes, and occasional breakage while the runtime is actively evolving.

## Cloudflare Pages Deploy

The web app is configured for Cloudflare Pages in [wrangler.jsonc](./wrangler.jsonc). SPA deep-link fallback is handled by [public/\_redirects](./public/_redirects).

One-time project setup:

```bash
pnpm --filter @shadowbox/web exec wrangler pages project create shadowbox-web
```

Staging deploy flow:

```bash
export VITE_BRAIN_BASE_URL="https://<brain-staging-url>"
export VITE_MUSCLE_BASE_URL="https://<secure-agent-api-staging-url>"
export VITE_MUSCLE_WS_URL="wss://<secure-agent-api-staging-url>"
pnpm --filter @shadowbox/web deploy:staging
```

Production deploy flow (`agents.legioncode.dev`):

```bash
export VITE_BRAIN_BASE_URL="https://brain.legioncode.dev"
export VITE_MUSCLE_BASE_URL="https://api.legioncode.dev"
export VITE_MUSCLE_WS_URL="wss://api.legioncode.dev"
pnpm --filter @shadowbox/web build:deploy
pnpm --filter @shadowbox/web exec wrangler pages deploy --branch main
```

Production domain/OAuth closure checklist:

- Pages project/domain points to `https://agents.legioncode.dev`
- Landing Pages project points to `https://legioncode.dev` and
  proxies `/agents/*` to the web app via
  `apps/landing/functions/agents/[[path]].ts`
- Brain `FRONTEND_URL` is `https://agents.legioncode.dev`
- Brain `GITHUB_REDIRECT_URI` is `https://brain.legioncode.dev/auth/github/callback`
- Secure API `CORS_ALLOWED_ORIGINS` includes
  `https://agents.legioncode.dev` and `https://legioncode.dev`
  (and optional staging origin only)

Manual Pages deploy with an explicit branch label:

```bash
pnpm --filter @shadowbox/web build:deploy
pnpm --filter @shadowbox/web exec wrangler pages deploy --branch <branch-name>
```

## Provider API Contract

The web app consumes provider routes through `ProviderApiClient` only:

- `POST /api/byok/providers/connect` (provider API path)
- `POST /api/byok/providers/disconnect`
- `GET /api/byok/providers/connections`
- `GET /api/byok/providers/catalog`
- `POST /api/byok/providers/validate`
- `PATCH /api/byok/preferences`
