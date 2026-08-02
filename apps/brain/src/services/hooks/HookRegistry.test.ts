import { describe, expect, it } from "vitest";
import { HookRegistry } from "./HookRegistry";

const definition = {
  handlerId: "project.session",
  eventName: "SessionStart",
  source: "project",
  displayName: "Project session hook",
  enabled: true,
  order: 10,
  timeoutMs: 1_000,
  configurationKey: "project:hooks/session",
} as const;

describe("HookRegistry", () => {
  it("validates, filters, and deterministically orders an immutable snapshot", () => {
    const registry = new HookRegistry([
      { ...definition, handlerId: "user.late", source: "user", order: 20 },
      {
        ...definition,
        handlerId: "plugin.same_order",
        source: "plugin",
      },
      definition,
      { ...definition, handlerId: "project.disabled", enabled: false, order: 0 },
    ]);

    expect(
      registry.enabledFor("SessionStart").map((hook) => hook.handlerId),
    ).toEqual(["project.session", "plugin.same_order", "user.late"]);
    expect(registry.list()).toHaveLength(4);
    expect(Object.isFrozen(registry.list())).toBe(true);
  });

  it("rejects duplicate handlers and unsupported runtime events", () => {
    expect(() => new HookRegistry([definition, definition])).toThrow(
      "Duplicate hook handler registration",
    );
    expect(
      () =>
        new HookRegistry([
          { ...definition, eventName: "PreToolUse", handlerId: "project.tool" },
        ]),
    ).toThrow();
  });
});
