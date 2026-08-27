import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceViewport } from "./useWorkspaceViewport";

describe("useWorkspaceViewport", () => {
  const listeners = new Set<() => void>();
  let width = 1280;

  beforeEach(() => {
    width = 1280;
    listeners.clear();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("767") ? width <= 767 : width <= 1023,
      media: query,
      onchange: null,
      addEventListener: (_event: string, listener: () => void) =>
        listeners.add(listener),
      removeEventListener: (_event: string, listener: () => void) =>
        listeners.delete(listener),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  it("tracks desktop, tablet, and mobile workspace modes", () => {
    const { result } = renderHook(() => useWorkspaceViewport());
    expect(result.current).toEqual({ isMobile: false, isCompact: false });

    act(() => {
      width = 900;
      listeners.forEach((listener) => listener());
    });
    expect(result.current).toEqual({ isMobile: false, isCompact: true });

    act(() => {
      width = 600;
      listeners.forEach((listener) => listener());
    });
    expect(result.current).toEqual({ isMobile: true, isCompact: true });
  });
});
