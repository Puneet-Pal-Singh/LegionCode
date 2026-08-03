import { evaluatePermission } from "@repo/permission-policy";
import { describe, expect, it } from "vitest";
import { NativePermissionPolicyResolver } from "./NativePermissionPolicyResolver.js";

describe("NativePermissionPolicyResolver", () => {
  it("allows reads but asks for writes in supervised mode", async () => {
    const policy = await new NativePermissionPolicyResolver(
      "ask_always",
    ).resolve();

    expect(
      evaluatePermission(policy, { domain: "tool", toolName: "read_file" })
        .effect,
    ).toBe("allow");
    expect(
      evaluatePermission(policy, { domain: "tool", toolName: "write_file" })
        .effect,
    ).toBe("ask");
  });

  it("preserves automatic workspace writes outside supervised mode", async () => {
    const policy = await new NativePermissionPolicyResolver(
      "auto_for_safe",
    ).resolve();

    expect(
      evaluatePermission(policy, {
        domain: "path",
        path: "src/index.ts",
        operation: "write",
      }).effect,
    ).toBe("allow");
  });
});
