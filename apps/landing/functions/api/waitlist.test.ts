import { describe, expect, it, vi } from "vitest";
import { handleWaitlistRequest } from "../_shared/waitlist";

function createRequest(body: unknown): Request {
  return new Request("https://legioncode.dev/api/waitlist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("handleWaitlistRequest", () => {
  it("normalizes and persists a valid email", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const response = await handleWaitlistRequest(
      createRequest({ email: "  USER@Example.com " }),
      { save },
    );

    expect(response.status).toBe(202);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "user@example.com",
        source: "cloud-page",
      }),
    );
  });

  it("rejects invalid email input", async () => {
    const save = vi.fn();
    const response = await handleWaitlistRequest(
      createRequest({ email: "not-an-email" }),
      { save },
    );

    expect(response.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it("accepts honeypot submissions without persisting them", async () => {
    const save = vi.fn();
    const response = await handleWaitlistRequest(
      createRequest({ email: "bot@example.com", company: "spam" }),
      { save },
    );

    expect(response.status).toBe(202);
    expect(save).not.toHaveBeenCalled();
  });
});
