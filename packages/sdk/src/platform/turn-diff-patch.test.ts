import { describe, expect, it } from "vitest";
import type { TurnDiffPayload, TurnId } from "@repo/platform-protocol";
import { buildDiffContentFromTurnDiff } from "./turn-diff-patch.js";

const TURN_ID = "trn_diff01" as TurnId;

describe("TurnDiffPatchParser", () => {
  it("loads a file diff from the immutable canonical turn patch", () => {
    const diff = buildDiffContentFromTurnDiff(
      turnDiff(`diff --git a/apps/web/src/a.ts b/apps/web/src/a.ts
index 1111111..2222222 100644
--- a/apps/web/src/a.ts
+++ b/apps/web/src/a.ts
@@ -1,2 +1,2 @@
 const keep = true;
-const oldName = "before";
+const newName = "after";
diff --git a/apps/web/src/b.ts b/apps/web/src/b.ts
new file mode 100644
--- /dev/null
+++ b/apps/web/src/b.ts
@@ -0,0 +1 @@
+export const value = 1;
`),
      "apps/web/src/a.ts",
    );

    expect(diff?.oldPath).toBe("apps/web/src/a.ts");
    expect(diff?.newPath).toBe("apps/web/src/a.ts");
    expect(diff?.isNewFile).toBe(false);
    expect(diff?.hunks).toHaveLength(1);
    expect(diff?.hunks[0]?.lines.map((line) => line.type)).toEqual([
      "unchanged",
      "deleted",
      "added",
    ]);

    const reusedPath = turnDiff(`diff --git a/a.ts b/b.ts
similarity index 100%
rename from a.ts
rename to b.ts
diff --git a/a.ts b/a.ts
new file mode 100644
--- /dev/null
+++ b/a.ts
@@ -0,0 +1 @@
+new content`);
    expect(buildDiffContentFromTurnDiff(reusedPath, "a.ts")).toMatchObject({
      newPath: "a.ts", isNewFile: true,
      hunks: [{ lines: [{ type: "added", content: "+new content" }] }],
    });
    expect(buildDiffContentFromTurnDiff(reusedPath, "b.ts")).toMatchObject({
      oldPath: "a.ts", newPath: "b.ts", isNewFile: false, hunks: [],
    });

    // Metadata-only patches remain real saved changes without invented hunks.
    for (const [patch, path, expected] of [
      ["diff --git a/image.bin b/image.bin\nBinary files a/image.bin and b/image.bin differ", "image.bin",
        { oldPath: "image.bin", newPath: "image.bin", isBinary: true, isNewFile: false, isDeleted: false }],
      ["diff --git a/new.bin b/new.bin\nnew file mode 100755\nGIT binary patch\nliteral 1\nAc", "new.bin",
        { oldPath: "new.bin", newPath: "new.bin", isBinary: true, isNewFile: true, isDeleted: false }],
      ["diff --git a/old.bin b/old.bin\ndeleted file mode 120000\nBinary files a/old.bin and /dev/null differ", "old.bin",
        { oldPath: "old.bin", newPath: "old.bin", isBinary: true, isNewFile: false, isDeleted: true }],
      ["diff --git a/old name.ts b/new name.ts\nsimilarity index 100%\nrename from old name.ts\nrename to new name.ts", "new name.ts",
        { oldPath: "old name.ts", newPath: "new name.ts", isBinary: false, isNewFile: false, isDeleted: false }],
      ["diff --git a/source.ts b/copy.ts\nsimilarity index 100%\ncopy from source.ts\ncopy to copy.ts", "copy.ts",
        { oldPath: "source.ts", newPath: "copy.ts", isBinary: false, isNewFile: false, isDeleted: false }],
      ["diff --git a/script.sh b/script.sh\nold mode 100644\nnew mode 100755", "script.sh",
        { oldPath: "script.sh", newPath: "script.sh", isBinary: false, isNewFile: false, isDeleted: false }],
      ["diff --git a/space b/image.bin b/space b/image.bin\nGIT binary patch", "space b/image.bin",
        { oldPath: "space b/image.bin", newPath: "space b/image.bin", isBinary: true, isNewFile: false, isDeleted: false }],
      [String.raw`diff --git "a/old\t\"\\.ts" "b/new\t\"\\.ts"
similarity index 100%
rename from "old\t\"\\.ts"
rename to "new\t\"\\.ts"`, "new\t\"\\.ts",
        { oldPath: "old\t\"\\.ts", newPath: "new\t\"\\.ts", isBinary: false, isNewFile: false, isDeleted: false }],
      [String.raw`diff --git "a/\303\251.bin" "b/\303\251.bin"
GIT binary patch`, "é.bin",
        { oldPath: "é.bin", newPath: "é.bin", isBinary: true, isNewFile: false, isDeleted: false }],
    ] as const) {
      const payload = turnDiff(patch);
      payload.files = [{
        path,
        previousPath: expected.oldPath !== expected.newPath ? expected.oldPath : null,
        status: expected.isNewFile ? "added" : expected.isDeleted ? "deleted"
          : expected.oldPath !== expected.newPath ? "renamed" : "modified",
        additions: null,
        deletions: null,
      }];
      const original = structuredClone(payload);
      expect(buildDiffContentFromTurnDiff(payload, path)).toEqual({ ...expected, hunks: [] });
      expect(payload).toEqual(original);
    }

  });

  it("returns null when the canonical patch does not contain the file", () => {
    expect(
      buildDiffContentFromTurnDiff(turnDiff(""), "apps/web/src/missing.ts"),
    ).toBeNull();
  });
});

function turnDiff(patch: string): TurnDiffPayload {
  return {
    turnId: TURN_ID,
    startSnapshot: {
      turnId: TURN_ID,
      snapshotKey: "start",
      treeId: "a".repeat(40),
      headSha: "b".repeat(40),
      phase: "start",
      capturedAt: "2026-06-23T00:00:00.000Z",
    },
    terminalSnapshot: {
      turnId: TURN_ID,
      snapshotKey: "terminal",
      treeId: "c".repeat(40),
      headSha: "d".repeat(40),
      phase: "terminal",
      capturedAt: "2026-06-23T00:00:01.000Z",
    },
    files: [],
    patch,
  };
}
