import { describe, expect, it } from "vitest";
import {
  parsePatchFileDiff,
  parsePatchFileInventory,
} from "./EditArtifactPatchParser";

const PATCH = `diff --git a/src/old.ts b/src/new.ts
similarity index 88%
rename from src/old.ts
rename to src/new.ts
--- a/src/old.ts
+++ b/src/new.ts
@@ -1,2 +1,2 @@
 export const keep = true;
-export const name = "old";
+export const name = "new";
diff --git a/src/added.ts b/src/added.ts
new file mode 100644
--- /dev/null
+++ b/src/added.ts
@@ -0,0 +1 @@
+export const added = true;
`;

describe("EditArtifactPatchParser", () => {
  it("parses file inventory from a saved git patch", () => {
    expect(parsePatchFileInventory(PATCH)).toEqual([
      {
        path: "src/new.ts",
        status: "renamed",
        additions: 1,
        deletions: 1,
        diffAvailable: true,
        artifactPath: "src/new.ts",
      },
      {
        path: "src/added.ts",
        status: "added",
        additions: 1,
        deletions: 0,
        diffAvailable: true,
        artifactPath: "src/added.ts",
      },
    ]);
  });

  it("parses a requested file diff into DiffContent", () => {
    const diff = parsePatchFileDiff({ patch: PATCH, path: "src/new.ts" });

    expect(diff).toMatchObject({
      oldPath: "src/old.ts",
      newPath: "src/new.ts",
      isBinary: false,
      isNewFile: false,
      isDeleted: false,
    });
    expect(diff.hunks[0]?.lines).toEqual([
      {
        type: "unchanged",
        content: "export const keep = true;",
        oldLineNumber: 1,
        newLineNumber: 1,
      },
      {
        type: "deleted",
        content: 'export const name = "old";',
        oldLineNumber: 2,
      },
      {
        type: "added",
        content: 'export const name = "new";',
        newLineNumber: 2,
      },
    ]);
  });

  it("parses a binary file without hunks", () => {
    const binaryPatch = `diff --git a/logo.png b/logo.png
new file mode 100644
index 0000000..abc1234
Binary files /dev/null and b/logo.png differ`;

    expect(parsePatchFileInventory(binaryPatch)).toEqual([
      {
        path: "logo.png",
        status: "added",
        additions: 0,
        deletions: 0,
        diffAvailable: false,
        artifactPath: "logo.png",
      },
    ]);

    const diff = parsePatchFileDiff({ patch: binaryPatch, path: "logo.png" });
    expect(diff.isBinary).toBe(true);
    expect(diff.isNewFile).toBe(true);
    expect(diff.isDeleted).toBe(false);
    expect(diff.hunks).toEqual([]);
  });

  it("parses a deleted file", () => {
    const deletePatch = `diff --git a/old.ts b/old.ts
deleted file mode 100644
--- a/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const kept = true;
-export const removed = true;`;

    expect(parsePatchFileInventory(deletePatch)).toEqual([
      {
        path: "old.ts",
        status: "deleted",
        additions: 0,
        deletions: 2,
        diffAvailable: true,
        artifactPath: "old.ts",
      },
    ]);

    const diff = parsePatchFileDiff({ patch: deletePatch, path: "old.ts" });
    expect(diff.isDeleted).toBe(true);
    expect(diff.isNewFile).toBe(false);
    expect(diff.isBinary).toBe(false);
  });

  it("parses a pure rename without inline diff", () => {
    const renamePatch = `diff --git a/src/old.ts b/src/new.ts
similarity index 100%
rename from src/old.ts
rename to src/new.ts`;

    expect(parsePatchFileInventory(renamePatch)).toEqual([
      {
        path: "src/new.ts",
        status: "renamed",
        additions: 0,
        deletions: 0,
        diffAvailable: false,
        artifactPath: "src/new.ts",
      },
    ]);
  });

  it("throws on an empty patch", () => {
    expect(() => parsePatchFileInventory("")).toThrow("Saved artifact patch is empty");
    expect(() => parsePatchFileInventory("  ")).toThrow("Saved artifact patch is empty");
  });

  it("throws when file path not found in patch", () => {
    expect(() =>
      parsePatchFileDiff({ patch: PATCH, path: "nonexistent.ts" }),
    ).toThrow("No saved patch block found for nonexistent.ts");
  });
});
