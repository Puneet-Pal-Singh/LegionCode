import { describe, expect, it } from "vitest";

import {
  assertTrustedDesktopFrame,
  resolveDesktopAppServerRequest,
  WorkspaceSelectionTokens,
} from "./request-security";

describe("Desktop App Server request security", () => {
  it("rejects malformed and unknown request envelopes", () => {
    const selections = new WorkspaceSelectionTokens();
    expect(() =>
      resolveDesktopAppServerRequest(
        { protocolVersion: "wrong", method: "thread/list", params: {} },
        1,
        selections,
      ),
    ).toThrow();
    expect(() =>
      resolveDesktopAppServerRequest(
        { protocolVersion: "1.0.0", method: "filesystem/read", params: {} },
        1,
        selections,
      ),
    ).toThrow();
  });

  it("rejects renderer-supplied paths and rewrites a sender-bound picker token", () => {
    const selections = new WorkspaceSelectionTokens();
    const request = {
      protocolVersion: "1.0.0",
      method: "workspace/grant",
      params: { path: "/private/repository" },
    };
    expect(() => resolveDesktopAppServerRequest(request, 14, selections)).toThrow(
      "Desktop workspace grants require a picker selection",
    );

    selections.issue(
      "one-time-selection-token",
      "/private/repository",
      14,
      Date.now() + 5_000,
    );
    expect(() =>
      resolveDesktopAppServerRequest(
        {
          protocolVersion: "1.0.0",
          method: "workspace/grant",
          params: { selectionToken: "one-time-selection-token" },
        },
        15,
        selections,
      ),
    ).toThrow("Workspace selection is expired or unavailable");

    const resolved = resolveDesktopAppServerRequest(
      {
        protocolVersion: "1.0.0",
        method: "workspace/grant",
        params: { selectionToken: "one-time-selection-token" },
      },
      14,
      selections,
    );
    expect(resolved.params).toEqual({ path: "/private/repository" });
    expect(() =>
      resolveDesktopAppServerRequest(
        {
          protocolVersion: "1.0.0",
          method: "workspace/grant",
          params: { selectionToken: "one-time-selection-token" },
        },
        14,
        selections,
      ),
    ).toThrow("Workspace selection is expired or unavailable");
  });

  it("invalidates replaced selections and expires at the exact deadline", () => {
    const selections = new WorkspaceSelectionTokens();
    selections.issue("first-token", "/first", 14, 100);
    selections.issue("second-token", "/second", 14, 200);
    expect(selections.consume("first-token", 14, 50)).toBeNull();
    expect(selections.consume("second-token", 14, 200)).toBeNull();
  });

  it("rejects subframes, unregistered windows, and renderer URL changes", () => {
    const base = {
      senderFrameRoutingId: 3,
      mainFrameRoutingId: 3,
      senderFrameUrl: "file:///app/renderer/index.html",
      expectedRendererUrl: "file:///app/renderer/index.html",
      hasDesktopWindow: true,
    };
    expect(() => assertTrustedDesktopFrame(base)).not.toThrow();
    expect(() =>
      assertTrustedDesktopFrame({ ...base, senderFrameRoutingId: 4 }),
    ).toThrow("Untrusted Desktop renderer");
    expect(() =>
      assertTrustedDesktopFrame({ ...base, hasDesktopWindow: false }),
    ).toThrow("Untrusted Desktop renderer");
    expect(() =>
      assertTrustedDesktopFrame({ ...base, senderFrameUrl: "https://example.com" }),
    ).toThrow("Untrusted Desktop renderer");
  });
});
