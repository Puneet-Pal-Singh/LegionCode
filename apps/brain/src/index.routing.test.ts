import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Brain auth route wiring", () => {
  it("registers logout as a POST route", () => {
    const workerSource = readFileSync(new URL("./index.ts", import.meta.url),
      "utf8",
    );

    expect(workerSource).toContain(
      'router.add(/\\/auth\\/logout/, AuthController.handleLogout, "POST");',
    );
  });
});
