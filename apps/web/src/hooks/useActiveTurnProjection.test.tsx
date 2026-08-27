import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createLifecycleProjection } from "../services/lifecycle/LifecycleProjection";
import type { TurnId } from "../services/api/lifecycleClient";
import {
  deriveCanonicalRunLoading,
  resolveActiveProjectionTurnId,
  useActiveTurnProjection,
} from "./useActiveTurnProjection";

const lifecycleMock = vi.hoisted(() => ({
  projection: null as ReturnType<typeof createLifecycleProjection> | null,
}));

vi.mock("./useTurnLifecycleProjection.js", () => ({
  useTurnLifecycleProjection: () => ({ projection: lifecycleMock.projection }),
}));

describe("useActiveTurnProjection", () => {
  it("keeps a newly submitted scope from projecting a stale terminal turn", () => {
    expect(
      resolveActiveProjectionTurnId({
        activeTurnId: null,
        serverTurnId: "trn_previous001",
        isSubmitting: true,
      }),
    ).toBeNull();
    expect(
      resolveActiveProjectionTurnId({
        activeTurnId: "trn_current001",
        serverTurnId: "trn_previous001",
        isSubmitting: true,
      }),
    ).toBe("trn_current001");
  });

  it("keeps transport loading pre-lifecycle and does not create workflow truth", () => {
    lifecycleMock.projection = null;
    const { result } = renderHook(() =>
      useActiveTurnProjection({ turnId: null, transportLoading: true }),
    );

    expect(result.current.isTransportPending).toBe(true);
    expect(result.current.isActive).toBe(false);
    expect(result.current.hasCanonicalTurn).toBe(false);
  });

  it("uses terminal lifecycle state as the only completion authority", () => {
    const projection = createLifecycleProjection("trn_active001" as TurnId);
    lifecycleMock.projection = {
      ...projection,
      lastSequence: 4,
      terminal: {
        state: "completed",
        eventId: "evt_terminal",
        content: "Done",
        occurredAt: "2026-07-10T00:00:00.000Z",
      },
    };
    const { result } = renderHook(() =>
      useActiveTurnProjection({
        turnId: "trn_active001",
        transportLoading: true,
      }),
    );

    expect(result.current.isTerminal).toBe(true);
    expect(result.current.isActive).toBe(false);
    expect(result.current.isTransportPending).toBe(false);
    expect(deriveCanonicalRunLoading(result.current, true)).toBe(false);
  });

  it("keeps the workflow active while canonical replay is catching up", () => {
    lifecycleMock.projection = createLifecycleProjection(
      "trn_pending001" as TurnId,
    );
    const { result } = renderHook(() =>
      useActiveTurnProjection({
        turnId: "trn_pending001",
        transportLoading: false,
      }),
    );

    expect(result.current.hasCanonicalTurn).toBe(true);
    expect(result.current.hasReplay).toBe(false);
    expect(deriveCanonicalRunLoading(result.current, false)).toBe(true);
  });
});
