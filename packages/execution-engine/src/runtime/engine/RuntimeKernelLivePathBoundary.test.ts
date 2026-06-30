import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(
  new URL("../../../../../", import.meta.url),
);
const BRAIN_RUN_HANDLER = join(
  REPO_ROOT,
  "apps/brain/src/runtime/RunEngineRequestHandler.ts",
);

describe("RuntimeKernel live path boundary", () => {
  it("keeps Brain execution routed through the RuntimeKernel adapter", () => {
    const source = readFileSync(BRAIN_RUN_HANDLER, "utf8");

    expect(source).toContain("executeRunEngineThroughRuntimeKernel");
    expect(source).not.toMatch(
      /const\s+executionResponse\s*=\s*await\s+runEngine\.execute\(/,
    );
  });
});
