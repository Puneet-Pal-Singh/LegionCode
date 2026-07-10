import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const ALLOWED_DIRECT_EXEC_FILES = [
  "src/plugins/RedisPlugin.ts",
  "src/toolbox/adapters/CloudflareToolboxAdapter.ts",
];

describe("direct sandbox exec guard", () => {
  it("restricts direct sandbox.exec usage to approved adapter/bootstrap files", () => {
    const output = execSync(
      "cd apps/secure-agent-api && rg -l \"sandbox\\\\.exec\\\\(\" src -g '!**/*.test.ts'",
      { encoding: "utf8" },
    ).trim();

    const files = output.length === 0
      ? []
      : output.split("\n").sort((left, right) => left.localeCompare(right));

    expect(files).toEqual(ALLOWED_DIRECT_EXEC_FILES);
  });
});
