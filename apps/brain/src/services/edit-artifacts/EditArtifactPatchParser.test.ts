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
});
