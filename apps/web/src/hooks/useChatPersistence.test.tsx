import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatPersistence } from "./useChatPersistence";

describe("useChatPersistence", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("does not replay a pending query before transcript hydration completes", async () => {
    localStorage.setItem("shadowbox:pending-query:session-1", "hi");
    const append = vi.fn<[{ role: "user"; content: string }], Promise<void>>(
      async () => undefined,
    );

    const { rerender } = renderHook(
      ({ hasHydrated }) =>
        useChatPersistence({
          sessionId: "session-1",
          runId: "run-1",
          messages: [],
          messagesLength: 0,
          isLoading: false,
          hasHydrated,
          isModelConfigReady: true,
          append,
        }),
      { initialProps: { hasHydrated: false } },
    );

    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(append).not.toHaveBeenCalled();

    rerender({ hasHydrated: true });

    await waitFor(() => {
      expect(append).toHaveBeenCalledWith({ role: "user", content: "hi" });
    });
  });
});
