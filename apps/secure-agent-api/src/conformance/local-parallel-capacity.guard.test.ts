import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { validateSecureRuntimeLocalCapacity } from "../../scripts/validate-local-wrangler-config.mjs";

const MINIMUM_PARALLEL_RUN_CAPACITY = 3;

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

  it("requires local worker names and service bindings to match canonical config", () => {
    const canonicalPath = decodeURIComponent(
      new URL("../../wrangler.jsonc", import.meta.url).pathname,
    );
    const canonical = readFileSync(canonicalPath, "utf8");
    const temporaryDirectory = mkdtempSync(
      join(tmpdir(), "secure-local-config-"),
    );
    const localPath = join(temporaryDirectory, "wrangler.local.jsonc");

    try {
      writeFileSync(localPath, canonical);
      expect(
        validateSecureRuntimeLocalCapacity({
          canonical: canonicalPath,
          local: localPath,
        }),
      ).toBe(6);

      writeFileSync(
        localPath,
        canonical.replace('"name": "legioncode-api"', '"name": "old-api"'),
      );
      expect(() =>
        validateSecureRuntimeLocalCapacity({
          canonical: canonicalPath,
          local: localPath,
        }),
      ).toThrow(/config names and service bindings/i);

      writeFileSync(
        localPath,
        canonical.replace(
          '"service": "legioncode-brain"',
          '"service": "old-brain"',
        ),
      );
      expect(() =>
        validateSecureRuntimeLocalCapacity({
          canonical: canonicalPath,
          local: localPath,
        }),
      ).toThrow(/config names and service bindings/i);
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
