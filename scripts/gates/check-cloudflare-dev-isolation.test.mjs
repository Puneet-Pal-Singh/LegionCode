import assert from "node:assert/strict";
import { test } from "node:test";
import { validateCloudflareDevIsolation } from "./check-cloudflare-dev-isolation.mjs";

test("Cloudflare dev resources are isolated without reusing production Postgres", () => {
  const errors = validateCloudflareDevIsolation();
  assert.ok(
    !errors.some((error) =>
      error.includes("dev KV namespace ID is not provisioned"),
    ),
    `the provisioned dev KV must pass, received: ${errors.join("; ")}`,
  );
  assert.deepEqual(errors, []);
});
