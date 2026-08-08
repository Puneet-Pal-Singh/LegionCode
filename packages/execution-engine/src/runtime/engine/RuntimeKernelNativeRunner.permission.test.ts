import { describe, expect, it } from "vitest";
import { requirePersistedPermissionContext } from "./RuntimePermissionContext.js";

describe("requirePersistedPermissionContext", () => {
  it("fails closed when a resumed run lacks persisted policy context", () => {
    expect(() =>
      requirePersistedPermissionContext({
        id: "run_missing_context",
        metadata: {},
      } as never),
    ).toThrow(/missing persisted permission context/);
  });

  it("returns the persisted context without consulting current input", () => {
    const permissionContext = {
      state: { productMode: "supervised" },
      resolvedAt: "2026-08-08T00:00:00.000Z",
    };
    expect(
      requirePersistedPermissionContext({
        id: "run_with_context",
        metadata: { permissionContext },
      } as never),
    ).toEqual(permissionContext);
  });
});
