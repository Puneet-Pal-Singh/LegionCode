import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isChatNearBottom,
  useChatAutoScroll,
} from "./useChatAutoScroll";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isChatNearBottom", () => {
  it("keeps following when the reader is within the bottom threshold", () => {
    expect(
      isChatNearBottom({ clientHeight: 600, scrollHeight: 1_000, scrollTop: 280 }),
    ).toBe(true);
  });

  it("does not steal position from a reader browsing older messages", () => {
    expect(
      isChatNearBottom({ clientHeight: 600, scrollHeight: 1_000, scrollTop: 100 }),
    ).toBe(false);
  });

  it("forces a new prompt into view but leaves an older reading position alone", () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const element = document.createElement("div");
    element.append(document.createElement("div"));
    Object.defineProperties(element, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 1_000 },
      scrollTop: { configurable: true, value: 400, writable: true },
    });
    const scrollTo = vi.fn<[ScrollToOptions?], void>();
    Object.defineProperty(element, "scrollTo", { value: scrollTo });
    const scrollRef = { current: element };

    const { rerender } = renderHook(
      ({ latestMessageKey, lifecycleSequence }) =>
        useChatAutoScroll({
          activeRun: true,
          latestMessageKey,
          lifecycleSequence,
          placeholderVisible: false,
          scopeKey: "thread:run",
          scrollRef,
        }),
      {
        initialProps: { latestMessageKey: "message-1:user", lifecycleSequence: 1 },
      },
    );
    expect(scrollTo).toHaveBeenCalledTimes(1);

    element.scrollTop = 100;
    act(() => element.dispatchEvent(new Event("scroll")));
    rerender({ latestMessageKey: "message-1:user", lifecycleSequence: 2 });
    expect(scrollTo).toHaveBeenCalledTimes(1);

    rerender({ latestMessageKey: "message-2:user", lifecycleSequence: 2 });
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });
});
