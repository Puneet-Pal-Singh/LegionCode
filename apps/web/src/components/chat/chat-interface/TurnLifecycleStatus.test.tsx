import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLifecycleProjection,
  type LifecycleProjection,
} from "../../../services/lifecycle/LifecycleProjection.js";
import { TurnLifecycleStatus } from "./TurnLifecycleStatus.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("TurnLifecycleStatus", () => {
  it("shows an animated working duration anchored to the lifecycle event", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T10:00:05.000Z"));
    const projection = {
      ...createLifecycleProjection(
        "trn_status01" as LifecycleProjection["turnId"],
      ),
      phase: "working" as const,
      startedAt: "2026-07-18T10:00:00.000Z",
    };

    render(<TurnLifecycleStatus projection={projection} />);
    expect(screen.getByRole("status")).toHaveTextContent("Working for 5s");
    expect(screen.getByText("Working for 5s")).toHaveClass(
      "turn-lifecycle-shimmer",
    );

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Working for 6s");
  });
});
