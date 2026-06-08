import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

describe("landing metadata", () => {
  it("owns the public SEO metadata", () => {
    const html = readFileSync(resolve("index.html"), "utf8");

    expect(html).toContain("LegionCode - The OSS AI coding agents");
    expect(html).toContain("legioncode-og.png");
    expect(html).toContain('href="https://legioncode.dev/"');
    expect(html).toContain("legioncode-icon.svg");
    expect(html).toContain("Private alpha");
  });
});
