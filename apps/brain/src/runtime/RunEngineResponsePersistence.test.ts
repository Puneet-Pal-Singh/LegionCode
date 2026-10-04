import { describe, expect, it, vi } from "vitest";
import { PersistenceService } from "../services/PersistenceService";
import type { Env } from "../types/ai";
import { persistAssistantMessageFromRunResponse } from "./RunEngineResponsePersistence";

describe("legacy run response persistence", () => {
  it("does not write assistant text or terminal status outside lifecycle append", async () => {
    const persistAssistantTurn = vi.spyOn(PersistenceService.prototype, "persistAssistantTurn");
    const identity = {
      workspaceId: "wsp_123e4567e89b42d3a456426614174900",
      threadId: "thr_123e4567e89b42d3a456426614174900",
      turnId: "trn_123e4567e89b42d3a456426614174900",
      runAttemptId: "attempt_123e4567e89b42d3a456426614174900",
    };

    await expect(
      persistAssistantMessageFromRunResponse(
        {},
        {} as Env,
        "session-a",
        "run_123e4567e89b42d3a456426614174900",
        "corr-1",
        new Response("legacy response text"),
        identity,
      ),
    ).resolves.toBeNull();
    expect(persistAssistantTurn).not.toHaveBeenCalled();
  });
});
