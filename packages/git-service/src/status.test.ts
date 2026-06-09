import { describe, expect, it } from "vitest";

import { GitServiceError } from "./errors.js";
import { parsePorcelainV2Status } from "./status.js";

const OBJECT_ID = "1234567890abcdef1234567890abcdef12345678";
const ALT_OBJECT_ID = "abcdef1234567890abcdef1234567890abcdef12";

describe("parsePorcelainV2Status", () => {
  it("parses branch headers and ordinary entries without mutating status", () => {
    const output = [
      "# branch.oid 1234567890abcdef1234567890abcdef12345678",
      "# branch.head feat/git-service-core",
      "# branch.upstream origin/feat/git-service-core",
      "# branch.ab +2 -1",
      `1 M. N... 100644 100644 100644 ${OBJECT_ID} ${ALT_OBJECT_ID} src/file with spaces.ts`,
      "? src/new file.ts",
      "",
    ].join("\0");

    const result = parsePorcelainV2Status(output);

    expect(result.branch).toEqual({
      oid: OBJECT_ID,
      head: "feat/git-service-core",
      upstream: "origin/feat/git-service-core",
      ahead: 2,
      behind: 1,
      detached: false,
    });
    expect(result.isDirty).toBe(true);
    expect(result.changedFileCount).toBe(2);
    expect(result.entries[0]).toMatchObject({
      kind: "ordinary",
      status: "modified",
      path: "src/file with spaces.ts",
      xy: { index: "M", worktree: "." },
    });
    expect(result.entries[1]).toMatchObject({
      kind: "untracked",
      status: "untracked",
      path: "src/new file.ts",
    });
  });

  it("parses renamed and copied records with nul-separated previous paths", () => {
    const output = [
      `2 R. N... 100644 100644 100644 ${OBJECT_ID} ${ALT_OBJECT_ID} R100 src/new name.ts`,
      "src/old name.ts",
      `2 C. N... 100644 100644 100644 ${OBJECT_ID} ${ALT_OBJECT_ID} C75 src/copy.ts`,
      "src/source.ts",
      "",
    ].join("\0");

    const result = parsePorcelainV2Status(output);

    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toMatchObject({
      kind: "renamed_or_copied",
      status: "renamed",
      score: 100,
      path: "src/new name.ts",
      previousPath: "src/old name.ts",
    });
    expect(result.entries[1]).toMatchObject({
      kind: "renamed_or_copied",
      status: "copied",
      score: 75,
      path: "src/copy.ts",
      previousPath: "src/source.ts",
    });
  });

  it("parses conflicted unmerged records", () => {
    const output = [
      `u UU N... 100644 100644 100644 100644 ${OBJECT_ID} ${ALT_OBJECT_ID} ${OBJECT_ID} src/conflict.ts`,
      "",
    ].join("\0");

    const result = parsePorcelainV2Status(output);

    expect(result.entries[0]).toMatchObject({
      kind: "unmerged",
      status: "unmerged",
      path: "src/conflict.ts",
      xy: { index: "U", worktree: "U" },
    });
  });

  it("ignores unknown headers and rejects unknown records", () => {
    const clean = parsePorcelainV2Status("# future.header value\0");
    expect(clean.entries).toHaveLength(0);

    expect(() => parsePorcelainV2Status("! future-record\0")).toThrow(
      GitServiceError,
    );
  });

  it("rejects malformed rename records", () => {
    expect(() =>
      parsePorcelainV2Status(
        `2 R. N... 100644 100644 100644 ${OBJECT_ID} ${ALT_OBJECT_ID} R100 src/new.ts\0`,
      ),
    ).toThrow(GitServiceError);
  });
});
