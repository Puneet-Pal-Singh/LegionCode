import { describe, expect, it } from "vitest";
import type { TurnId } from "../api/lifecycleClient";
import {
  buildLifecycleTerminalViewModel,
} from "./LifecycleTerminalViewModel";
import type { LifecycleProjection } from "@legioncode/sdk";

const TURN_ID = "trn_view01" as TurnId;

describe("LifecycleTerminalViewModel", () => {
  it("renders terminal failure content from canonical terminal projection", () => {
    const terminal = buildLifecycleTerminalViewModel({
      ...emptyProjection(),
      terminal: {
        state: "failed",
        eventId: "evt_terminal001",
        content: "Turn failed: tool failure",
        occurredAt: "2026-06-23T00:00:00.000Z",
      },
    });

    expect(terminal).toEqual({
      id: `terminal:${TURN_ID}`,
      state: "failed_runtime",
      content: "Turn failed: tool failure",
      artifactId: null,
    });
  });

  it("renders completed assistant output inside its canonical turn surface", () => {
    const terminal = buildLifecycleTerminalViewModel({
      ...emptyProjection(),
      assistantText: "Done from canonical replay",
      terminal: {
        state: "completed",
        eventId: "evt_terminal002",
        content: "",
        occurredAt: "2026-06-23T00:00:00.000Z",
      },
    });

    expect(terminal).toMatchObject({
      state: "completed",
      content: "Done from canonical replay",
    });
  });


});

function emptyProjection(): LifecycleProjection {
  return {
    turnId: TURN_ID,
    phase: "starting",
    lastSequence: 0,
    items: [],
    hookAudits: [],
    pendingApproval: null,
    terminal: null,
    turnDiff: null,
    activeThinking: false,
    assistantText: "",
    startedAt: null,
    settledAt: null,
    contextBudget: null,
    usage: null,
  };
}
