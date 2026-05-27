import { describe, expect, it } from "vitest";
import {
  extractChangedFileFromToolResult,
  mergePromptChangedFilesWithGitStats,
} from "./EditArtifactCaptureService";

describe("EditArtifactCaptureService helpers", () => {
  it("extracts edit stats from top-level tool activity metadata", () => {
    const changedFile = extractChangedFileFromToolResult({
      content: "Updated src/hero.tsx",
      metadata: {
        activity: {
          family: "edit",
          filePath: "src/hero.tsx",
          additions: 12,
          deletions: 4,
        },
      },
    });

    expect(changedFile).toEqual({
      path: "src/hero.tsx",
      status: "modified",
      additions: 12,
      deletions: 4,
    });
  });

  it("extracts edit stats from nested tool output metadata", () => {
    const changedFile = extractChangedFileFromToolResult({
      output: {
        metadata: {
          activity: {
            family: "edit",
            filePath: "src/hero.tsx",
            additions: 3,
            deletions: 1,
          },
        },
      },
    });

    expect(changedFile).toMatchObject({
      path: "src/hero.tsx",
      additions: 3,
      deletions: 1,
    });
  });

  it("keeps prompt file scope while enriching matching git stats", () => {
    const changedFiles = mergePromptChangedFilesWithGitStats(
      [{ path: "src/hero.tsx", status: "modified" }],
      [
        {
          path: "src/hero.tsx",
          status: "modified",
          additions: 8,
          deletions: 2,
          isStaged: false,
        },
        {
          path: "src/footer.tsx",
          status: "modified",
          additions: 1,
          deletions: 1,
          isStaged: false,
        },
      ],
    );

    expect(changedFiles).toEqual([
      {
        path: "src/hero.tsx",
        status: "modified",
        additions: 8,
        deletions: 2,
        isStaged: false,
      },
    ]);
  });
});
