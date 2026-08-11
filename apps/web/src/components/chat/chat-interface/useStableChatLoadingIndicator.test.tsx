import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useStableChatLoadingIndicator } from "./useStableChatLoadingIndicator";

describe("useStableChatLoadingIndicator", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for uninterrupted readiness before revealing the transcript", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ loading }) => useStableChatLoadingIndicator(loading),
      { initialProps: { loading: true } },
    );

    rerender({ loading: false });
    act(() => vi.advanceTimersByTime(100));
    rerender({ loading: true });
    act(() => vi.advanceTimersByTime(200));
    expect(result.current).toBe(true);

    rerender({ loading: false });
    act(() => vi.advanceTimersByTime(179));
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(false);
  });
});
