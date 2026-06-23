import { afterEach, describe, expect, it, vi } from "vitest";

import { buildDocsTarget, onRequest, resolveDocsOrigin } from "./[[path]]";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildDocsTarget", () => {
  it("maps the public docs root to the upstream root", () => {
    const requestUrl = new URL("https://legioncode.dev/docs/");
    expect(buildDocsTarget("https://docs.legioncode.dev", requestUrl)).toBe(
      "https://docs.legioncode.dev/",
    );
  });

  it("strips the public docs prefix and preserves the query", () => {
    const requestUrl = new URL(
      "https://legioncode.dev/docs/overview/?source=landing",
    );
    expect(buildDocsTarget("https://docs.legioncode.dev", requestUrl)).toBe(
      "https://docs.legioncode.dev/overview/?source=landing",
    );
  });
});

describe("resolveDocsOrigin", () => {
  it("uses the production docs origin by default", () => {
    expect(resolveDocsOrigin(undefined)).toBe(
      "https://shadowbox-docs.pages.dev",
    );
  });

  it("rejects non-HTTPS upstream origins", () => {
    expect(() => resolveDocsOrigin("http://docs.example.com")).toThrow(
      "must use https",
    );
  });

  it("allows loopback HTTP origins for local development", () => {
    expect(resolveDocsOrigin("http://127.0.0.1:3001")).toBe(
      "http://127.0.0.1:3001",
    );
  });
});

describe("onRequest", () => {
  it("forwards docs requests to the independent deployment", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("docs", { status: 200 }));

    const response = await onRequest({
      request: new Request("https://legioncode.dev/docs/quickstart/"),
      env: { DOCS_ORIGIN: "https://docs.legioncode.dev" },
    });

    expect(await response.text()).toBe("docs");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://docs.legioncode.dev/quickstart/",
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("returns a gateway response when docs are unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const response = await onRequest({
      request: new Request("https://legioncode.dev/docs/"),
      env: {},
    });

    expect(response.status).toBe(502);
    expect(await response.text()).toBe("Docs app is unavailable.");
  });
});
