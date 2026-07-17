import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { validateLocalWranglerConfig } from "../../scripts/validate-local-wrangler-config.mjs";

const APP_ROOT = join(process.cwd());

function readText(path: string): string {
  return readFileSync(join(APP_ROOT, path), "utf8");
}

describe("local development configuration", () => {
  it("starts Brain dev with the local Wrangler config", () => {
    const packageJson = JSON.parse(readText("package.json")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.dev).toContain("--config wrangler.local.jsonc");
  });

  it("keeps the tracked local template aligned with canonical runtime config", () => {
    const defaultConfig = readText("wrangler.jsonc");
    const templateConfig = readText("wrangler.local.example.jsonc");
    const canonicalPath = join(APP_ROOT, "wrangler.jsonc");
    const templatePath = join(APP_ROOT, "wrangler.local.example.jsonc");

    expect(defaultConfig).toContain('"tag": "v6-quarantine-run-engine-agent"');
    expect(templateConfig).not.toContain('"name": "RUN_ENGINE_AGENT"');
    expect(templateConfig).toContain('"tag": "v6-quarantine-run-engine-agent"');
    expect(templateConfig).toContain('"class_name": "RunEngineRuntime"');
    expect(templateConfig).toContain('"class_name": "RunAdmissionLimiter"');
    expect(templateConfig).toContain('"deleted_classes": ["RunEngineAgent"]');
    expect(
      validateLocalWranglerConfig({
        canonical: canonicalPath,
        local: templatePath,
      }),
    ).toBe(true);
  });

  it("fails closed when the ignored local config is absent or drifts", () => {
    const canonicalPath = join(APP_ROOT, "wrangler.jsonc");
    const localPath = join(APP_ROOT, "wrangler.local.jsonc");

    expect(
      validateLocalWranglerConfig({
        canonical: canonicalPath,
        local: localPath,
      }),
    ).toBe(false);

    const temporaryDirectory = mkdtempSync(
      join(tmpdir(), "brain-local-config-"),
    );
    const staleConfigPath = join(temporaryDirectory, "wrangler.local.jsonc");
    writeFileSync(
      staleConfigPath,
      readFileSync(
        join(APP_ROOT, "wrangler.local.example.jsonc"),
        "utf8",
      ).replace('"name": "RUN_ENGINE_RUNTIME"', '"name": "RUN_ENGINE_AGENT"'),
    );

    try {
      expect(
        validateLocalWranglerConfig({
          canonical: canonicalPath,
          local: staleConfigPath,
        }),
      ).toBe(false);
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
