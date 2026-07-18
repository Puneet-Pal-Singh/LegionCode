import { describe, expect, it } from "vitest";
import { workspaceIdFromExternalId } from "./workspace-id.js";

describe("workspaceIdFromExternalId", () => {
  it("preserves protocol workspace ids and deterministically maps external ids", () => {
    expect(workspaceIdFromExternalId("wrk_workspace001")).toBe(
      "wrk_workspace001",
    );
    expect(
      workspaceIdFromExternalId("00000000-0000-4000-8000-000000000001"),
    ).toBe("wrk_00000000-0000-4000-8000-000000000001");
  });
});
