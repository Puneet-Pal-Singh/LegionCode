import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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

  it("keeps production-only deleted class migrations out of local dev", () => {
    const localConfig = readText("wrangler.local.jsonc");
    const defaultConfig = readText("wrangler.jsonc");

    expect(defaultConfig).toContain("deleted_classes");
    expect(defaultConfig).toContain("SessionMemoryRuntime");
    expect(localConfig).not.toContain("deleted_classes");
    expect(localConfig).not.toContain("SessionMemoryRuntime");
  });
});
