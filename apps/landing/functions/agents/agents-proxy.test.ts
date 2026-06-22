import { afterEach, describe, expect, it, vi } from "vitest";

import { buildAgentsTarget, onRequest, resolveAgentsOrigin } from "./[[path]]";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildAgentsTarget", () => {
  it("maps the public agents root to the upstream root", () => {
    const requestUrl = new URL("https://legioncode.dev/agents/");

    expect(buildAgentsTarget("https://agents.legioncode.dev", requestUrl)).toBe(
      "https://agents.legioncode.dev/",
    );
  });

  it("strips the public agents prefix from upstream asset requests", () => {
    const requestUrl = new URL(
      "https://legioncode.dev/agents/assets/index.js?v=1",
    );

    expect(buildAgentsTarget("https://agents.legioncode.dev", requestUrl)).toBe(
      "https://agents.legioncode.dev/assets/index.js?v=1",
    );
  });
});

describe("resolveAgentsOrigin", () => {
  it("uses the production agents origin by default", () => {
    expect(resolveAgentsOrigin(undefined)).toBe(
      "https://agents.legioncode.dev",
    );
  });

  it("rejects non-HTTPS upstream origins", () => {
    expect(() => resolveAgentsOrigin("http://agents.example.com")).toThrow(
      "must use https",
    );
  });
});

describe("onRequest", () => {
  it("forwards the request and preserves the upstream response", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("agents", { status: 200 }));

    const response = await onRequest({
      request: new Request("https://legioncode.dev/agents/assets/app.js?v=2"),
      env: { AGENTS_ORIGIN: "https://agents.legioncode.dev" },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("agents");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://agents.legioncode.dev/assets/app.js?v=2",
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("returns a typed gateway response when the upstream is unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await onRequest({
      request: new Request("https://legioncode.dev/agents/"),
      env: {},
    });

    expect(response.status).toBe(502);
    expect(await response.text()).toBe("Agents app is unavailable.");
  });
});
