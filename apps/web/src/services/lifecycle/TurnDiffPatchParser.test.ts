import { describe, expect, it } from "vitest";
import type { TurnDiffPayload, TurnId } from "../api/lifecycleClient";
import { buildDiffContentFromTurnDiff } from "./TurnDiffPatchParser";

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
