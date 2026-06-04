import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { describe, expect, it } from "vitest";

// The boundary test itself references these symbols; skip it when
// walking src/ so the guard does not match its own assertions.
const SELF_PATH = resolve("src/architecture/landing-boundary.test.ts");

function* walkTs(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walkTs(full);
    } else if (/\.(ts|tsx)$/.test(entry) && full !== SELF_PATH) {
      yield full;
    }
  }
}

describe("landing boundary", () => {
  it("keeps the landing page out of the web product app", () => {
    expect(existsSync(resolve("src/pages/LandingPage.tsx"))).toBe(false);
  });

  it("does not import LandingPage from the web app", () => {
    for (const file of walkTs(resolve("src"))) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/from\s+["'][^"']*LandingPage/);
    }
  });

  it("does not import CloudReservedPage from the web app", () => {
    for (const file of walkTs(resolve("src"))) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/from\s+["'][^"']*CloudReservedPage/);
    }
  });
});
