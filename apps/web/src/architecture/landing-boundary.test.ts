import { existsSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

describe("landing boundary", () => {
  it("keeps the landing page out of the web product app", () => {
    expect(existsSync(resolve("src/pages/LandingPage.tsx"))).toBe(false);
  });
});
