import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const MINIMUM_PARALLEL_RUN_CAPACITY = 2;

function readConfiguredCapacity(fileName: string): number {
  const configPath = decodeURIComponent(
    new URL(`../../${fileName}`, import.meta.url).pathname,
  );
  const config = readFileSync(configPath, "utf8");
  const match = config.match(/"max_instances"\s*:\s*(\d+)/);

  if (!match?.[1]) {
    throw new Error(`${fileName} does not declare containers[].max_instances`);
  }

  return Number.parseInt(match[1], 10);
}

describe("secure runtime parallel capacity", () => {
  it("keeps the canonical config capable of the product's minimum parallel run contract", () => {
    expect(readConfiguredCapacity("wrangler.jsonc")).toBeGreaterThanOrEqual(
      MINIMUM_PARALLEL_RUN_CAPACITY,
    );
  });

  it("makes local startup validate its ignored override against canonical capacity", () => {
    const startupScript = readFileSync(
      decodeURIComponent(
        new URL(
          "../../../../scripts/local-dev/run-workers-with-logs.sh",
          import.meta.url,
        ).pathname,
      ),
      "utf8",
    );
    expect(startupScript).toContain("apps/secure-agent-api");
    expect(startupScript).toContain(
      "node ./scripts/validate-local-wrangler-config.mjs",
    );
  });
});
