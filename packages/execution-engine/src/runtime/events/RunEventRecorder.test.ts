import { describe, expect, it, vi } from "vitest";
import { RunEventRepository } from "./RunEventRepository.js";
import { RunEventRecorder } from "./RunEventRecorder.js";

describe("RunEventRecorder", () => {
  it("fails when idempotent approval-resolved listener persistence fails", async () => {
    const repository = {
      appendApprovalResolvedIfMissing: vi.fn(async () => true),
    } as unknown as RunEventRepository;
    const eventListener = vi.fn(async () => {
      throw new Error("listener failure");
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const recorder = new RunEventRecorder(
      repository,
      "run-1",
      "session-1",
      eventListener,
    );

    await expect(
      recorder.recordApprovalResolvedIfNotExists({
        requestId: "req-1",
        decision: "allow_once",
        status: "approved",
      }),
    ).rejects.toThrow("listener failure");

    expect(eventListener).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("status=listener-failed"),
      expect.any(Error),
    );
    consoleError.mockRestore();
  });
});
