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

  it("parses quoted paths, deleted files, binary files, and pure renames", () => {
    const patch = `diff --git "a/src/old name.ts" "b/src/new name.ts"
similarity index 100%
rename from src/old name.ts
rename to src/new name.ts
diff --git a/assets/logo.png b/assets/logo.png
new file mode 100644
index 0000000..1234567
Binary files /dev/null and b/assets/logo.png differ
diff --git a/src/removed.ts b/src/removed.ts
deleted file mode 100644
--- a/src/removed.ts
+++ /dev/null
@@ -1 +0,0 @@
-export const removed = true;
`;

    expect(parsePatchFileInventory(patch)).toEqual([
      {
        path: "src/new name.ts",
        status: "renamed",
        additions: 0,
        deletions: 0,
        diffAvailable: false,
        artifactPath: "src/new name.ts",
      },
      {
        path: "assets/logo.png",
        status: "added",
        additions: 0,
        deletions: 0,
        diffAvailable: false,
        artifactPath: "assets/logo.png",
      },
      {
        path: "src/removed.ts",
        status: "deleted",
        additions: 0,
        deletions: 1,
        diffAvailable: true,
        artifactPath: "src/removed.ts",
      },
    ]);

    expect(
      parsePatchFileDiff({ patch, path: "assets/logo.png" }),
    ).toMatchObject({
      isBinary: true,
      isNewFile: true,
      hunks: [],
    });
  });
});
