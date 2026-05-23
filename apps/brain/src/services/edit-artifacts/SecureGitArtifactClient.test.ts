import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../types/ai";
import { SecureGitArtifactClient } from "./SecureGitArtifactClient";

describe("SecureGitArtifactClient", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("times out secure session creation instead of hanging forever", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      () => new Promise<Response>(() => undefined),
    );
    const client = new SecureGitArtifactClient(
      { SECURE_API: { fetch: fetchMock } as Env["SECURE_API"] } as Env,
      "muscle-run-1",
      "run-1",
      { sessionTimeoutMs: 5 },
    );

    const statusPromise = client.getStatus();
    const expectation = expect(statusPromise).rejects.toThrow(
      "Git git_status session creation timed out after 5ms",
    );

    await vi.advanceTimersByTimeAsync(5);

    await expectation;
    expect(fetchMock).toHaveBeenCalledWith(
      "http://internal/api/v1/session?session=muscle-run-1",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });
});
