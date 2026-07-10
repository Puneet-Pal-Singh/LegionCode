import { describe, expect, it, vi } from "vitest";
import { RUN_EVENT_TYPES } from "@repo/shared-types";
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

  it("records cancelled runtime status as a terminal run-event status", async () => {
    const repository = {
      append: vi.fn(async () => undefined),
    } as unknown as RunEventRepository;
    const recorder = new RunEventRecorder(repository, "run-1", "session-1");

    await recorder.recordRunStatusChanged(
      "RUNNING",
      "CANCELLED",
      "execution",
      "user_cancelled",
    );

    expect(repository.append).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        type: RUN_EVENT_TYPES.RUN_STATUS_CHANGED,
        payload: expect.objectContaining({
          previousStatus: "running",
          newStatus: "cancelled",
          reason: "user_cancelled",
        }),
      }),
    );
  });
});
