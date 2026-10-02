# CORS Configuration for Secure Agent API

## Overview

The Secure Agent API (`apps/secure-agent-api`) serves as the execution layer (Muscle) for LegionCode. It handles file operations, git operations, and execution isolation via Durable Objects. Since the web app (`apps/web`) runs on a different origin in local development, proper CORS configuration is essential.

## Local Development

### Quick Start

1. Copy `.dev.vars.example` to `.dev.vars`:

   ```bash
   cp apps/secure-agent-api/.dev.vars.example apps/secure-agent-api/.dev.vars
   ```

2. Set `CORS_ALLOW_DEV_ORIGINS=true` in your `.dev.vars`:

   ```ini
   CORS_ALLOW_DEV_ORIGINS=true
   ```

3. Start the development servers:

   ```bash
   # Terminal 1: Secure API (Muscle)
   pnpm --filter @legioncode/secure-agent-api dev

   # Terminal 2: Brain
   pnpm --filter @legioncode/brain dev

   # Terminal 3: Web
   pnpm --filter @legioncode/web dev
   ```

### What It Does

When `CORS_ALLOW_DEV_ORIGINS=true`, the API automatically allows cross-origin requests from:

- `http://localhost:*` (any port)
- `http://127.0.0.1:*` (any port)
- `http://[::1]:*` (IPv6 localhost, any port)

This enables the web app (typically `http://localhost:5173`) to call the API (typically `http://localhost:8787`) without browser CORS blocks.

### Configuration Options

#### Option 1: Dev Flag (Simplest)

```ini
CORS_ALLOW_DEV_ORIGINS=true
```

- Allows all `localhost`, `127.0.0.1`, and `::1` origins
- Best for local development
- Not suitable for production (security risk)

#### Option 2: Explicit Origins (Production-Safe)

```ini
CORS_ALLOWED_ORIGINS=https://app.example.com,https://api.example.com
```

- Whitelist specific origins
- Safe for production
- Comma-separated list
- Blank in development (use `CORS_ALLOW_DEV_ORIGINS` instead)

#### Option 3: Custom Dev Port

If you're running web on a non-standard port, you can either:

1. Add it to `CORS_ALLOWED_ORIGINS` explicitly, or
2. Keep `CORS_ALLOW_DEV_ORIGINS=true` to automatically allow it

## Implementation Details

The CORS implementation in `src/lib/cors.ts` provides two functions:

### `getCorsHeaders(request, env)`

Returns appropriate CORS headers based on the request origin and configuration.

**Logic:**

1. Check `CORS_ALLOWED_ORIGINS` for explicit whitelist matches
2. If `CORS_ALLOW_DEV_ORIGINS=true`, check if origin is a local dev origin
3. Return CORS headers only if origin is allowed

### `handleCorsPreflight(request, env)`

Handles OPTIONS preflight requests required by browsers for cross-origin requests.

**Returns:**

- 204 No Content with CORS headers if origin is allowed
- 403 Forbidden if origin is not allowed

## Headers Included

All CORS responses include:

```text
Access-Control-Allow-Methods: GET, POST, OPTIONS, DELETE
Access-Control-Allow-Headers: Content-Type, Authorization
Access-Control-Allow-Credentials: true (when origin matched)
X-Content-Type-Options: nosniff
Vary: Origin
```

The `Vary: Origin` header is crucial for proper caching behavior with cross-origin requests.

## Testing CORS

### Manual Test (curl)

```bash
# Test with localhost origin
curl -i -H "Origin: http://localhost:5173" \
  http://localhost:8787/api/chat/history/test-run-id

# Should see:
# Access-Control-Allow-Origin: http://localhost:5173
# Access-Control-Allow-Credentials: true
```

### OPTIONS Preflight

```bash
curl -i -X OPTIONS -H "Origin: http://localhost:5173" \
  http://localhost:8787/api/chat/history/test-run-id

# Should return 204 No Content with CORS headers
```

### Automated Tests

```bash
# Run CORS integration tests
pnpm --filter @legioncode/secure-agent-api test -- cors.test.js
```

## Common Issues

### "Access to XMLHttpRequest blocked by CORS"

**Cause:** `CORS_ALLOW_DEV_ORIGINS=false` (default in wrangler.jsonc)

**Fix:**

1. Create `.dev.vars` file in `apps/secure-agent-api/`
2. Set `CORS_ALLOW_DEV_ORIGINS=true`
3. Restart the dev server

### Browser console shows CORS error on history fetch

**Cause:** Web app can't fetch chat history from secure-api

**Fix:**

1. Verify `.dev.vars` has `CORS_ALLOW_DEV_ORIGINS=true`
2. Verify secure-api is running on `http://localhost:8787`
3. Check web app is making requests to correct origin
4. See `apps/web/src/lib/platform-endpoints.ts` for configured endpoints

### CORS works but API returns 404/500

**Cause:** CORS is fixed but the actual endpoint is broken

**Reason:** CORS headers are returned before the actual endpoint logic runs. Verify:

1. Endpoint exists and is registered
2. Authentication/authorization passes
3. Backend logic works (check server logs)

## Production Deployment

For production:

1. **Never use `CORS_ALLOW_DEV_ORIGINS`** in production
2. Set `CORS_ALLOWED_ORIGINS` to your exact app origin(s):
   ```
   CORS_ALLOWED_ORIGINS=https://legioncode.dev,https://staging.legioncode.dev
   ```
3. Store as a secret in Cloudflare Workers:
   ```bash
   wrangler secret put CORS_ALLOWED_ORIGINS
   ```
4. Test with production origin:
   ```bash
   curl -H "Origin: https://legioncode.dev" \
     https://api.legioncode.dev/api/chat/history/test-run-id
   ```

## References

- [MDN: Cross-Origin Resource Sharing](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS)
- [Cloudflare Workers: CORS](https://developers.cloudflare.com/workers/examples/cors-header-proxy/)
- `src/lib/cors.ts` — CORS implementation
- `.dev.vars.example` — Configuration template
