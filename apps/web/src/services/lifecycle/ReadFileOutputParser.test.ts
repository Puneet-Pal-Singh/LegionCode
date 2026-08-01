import { describe, expect, it } from "vitest";
import {
  normalizeReadFileContent,
  parseReadFileOutput,
} from "./ReadFileOutputParser";

describe("parseReadFileOutput", () => {
  it("removes runtime metadata and model-facing line prefixes", () => {
    const output = [
      "[read_file] path=src/Footer.tsx offset=4 limit=2 returnedLines=2 totalLines=20 truncated=true nextOffset=6",
      "5: const first = true;",
      "6: const second = true;",
      '[read_file] Continue with {"path":"src/Footer.tsx","offset":6,"limit":2} or use grep/glob to narrow.',
    ].join("\n");

    expect(parseReadFileOutput(output)).toEqual({
      content: "const first = true;\nconst second = true;",
      offset: 4,
      returnedLines: 2,
      totalLines: 20,
      truncated: true,
    });
  });

  it("leaves non-read output unchanged", () => {
    expect(normalizeReadFileContent("plain output")).toBe("plain output");
  });
});
