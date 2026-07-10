import { describe, expect, it } from "vitest";
import type { DiffContent } from "@repo/shared-types";
import {
  calculateChangedFileTotals,
  calculateDiffStats,
  getFileStats,
  splitPathForDisplay,
} from "./diff-statistics";

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

  it("prefers known file stats and computes unknown stats from a diff", () => {
    expect(
      getFileStats({
        path: "known.ts",
        status: "modified",
        additions: 4,
        deletions: 2,
        isStaged: false,
      }),
    ).toEqual({ additions: 4, deletions: 2 });

    expect(
      getFileStats(
        {
          path: "unknown.ts",
          status: "modified",
          additions: 0,
          deletions: 0,
          isStaged: false,
        },
        {
          loading: false,
          diff: {
            oldPath: "unknown.ts",
            newPath: "unknown.ts",
            isBinary: false,
            isNewFile: false,
            isDeleted: false,
            hunks: [],
          },
        },
      ),
    ).toEqual({ additions: 0, deletions: 0 });
  });

  it("propagates unknown totals while a diff is loading", () => {
    const file = {
      path: "loading.ts",
      status: "modified" as const,
      additions: 0,
      deletions: 0,
      isStaged: false,
    };
    expect(getFileStats(file, { loading: true })).toEqual({
      additions: null,
      deletions: null,
    });
    expect(
      calculateChangedFileTotals([file], { [file.path]: { loading: true } }),
    ).toEqual({
      additions: null,
      deletions: null,
    });
  });
});
