import { afterEach, describe, expect, it, vi } from "vitest";
import { logout } from "./GitHubService";

describe("GitHubService logout", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the credentialed logout request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await logout();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/auth\/logout$/u),
      expect.objectContaining({
        method: "POST",
        credentials: "include",
      }),
    );
  });

  it("rejects unsuccessful logout responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 500 })),
    );

    await expect(logout()).rejects.toThrow("Logout failed with status 500");
  });
});
