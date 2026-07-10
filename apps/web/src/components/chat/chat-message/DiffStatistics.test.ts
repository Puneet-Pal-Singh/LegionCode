import { describe, expect, it } from "vitest";
import type { DiffContent } from "@repo/shared-types";
import { calculateDiffStats, splitPathForDisplay } from "./diff-statistics";

describe("chat message diff statistics", () => {
  it("counts added and deleted lines from typed diff hunks", () => {
    const diff: DiffContent = {
      oldPath: "src/index.ts",
      newPath: "src/index.ts",
      isBinary: false,
      isNewFile: false,
      isDeleted: false,
      hunks: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 2,
          header: "@@",
          lines: [
            { type: "deleted", content: "-old", oldLineNumber: 1 },
            { type: "added", content: "+new", newLineNumber: 1 },
            { type: "added", content: "+more", newLineNumber: 2 },
          ],
        },
      ],
    };
    expect(calculateDiffStats(diff)).toEqual({ additions: 2, deletions: 1 });
  });

  it("splits a path into directory and basename for display", () => {
    expect(splitPathForDisplay("apps/web/src/ChatMessage.tsx")).toEqual({
      directory: "apps/web/src/",
      name: "ChatMessage.tsx",
    });
  });
});
