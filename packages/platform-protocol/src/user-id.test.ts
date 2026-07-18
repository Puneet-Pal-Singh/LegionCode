import { describe, expect, it } from "vitest";
import { userIdFromExternalId } from "./user-id.js";

describe("userIdFromExternalId", () => {
  it("preserves canonical ids and maps external subjects deterministically", () => {
    expect(userIdFromExternalId("usr_user001")).toBe("usr_user001");
    expect(userIdFromExternalId("github:123")).toBe("usr_github_123");
  });
});
