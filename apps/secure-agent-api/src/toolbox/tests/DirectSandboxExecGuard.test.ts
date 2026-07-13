import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ALLOWED_DIRECT_EXEC_FILES = [
  "src/plugins/RedisPlugin.ts",
  "src/toolbox/adapters/CloudflareToolboxAdapter.ts",
];

describe("direct sandbox exec guard", () => {
  it("restricts direct sandbox.exec usage to approved adapter/bootstrap files", () => {
    const output = execSync(
      "rg -l \"sandbox\\\\.exec\\\\(\" src -g '!**/*.test.ts'",
      {
        cwd: existsSync(join(process.cwd(), "src"))
          ? process.cwd()
          : join(process.cwd(), "apps/secure-agent-api"),
        encoding: "utf8",
      },
    ).trim();

    const files = output.length === 0
      ? []
      : output.split("\n").sort((left, right) => left.localeCompare(right));

    expect(files).toEqual(ALLOWED_DIRECT_EXEC_FILES);
  });
});
