import { ItemIdSchema } from "@repo/platform-protocol";
import { describe, expect, it } from "vitest";
import { RuntimeLifecycleCoordinator } from "./RuntimeLifecycleCoordinator.js";
import { createLifecycleSink, run, runAttemptId, turn } from "./test-fixtures.js";

describe("RuntimeLifecycleCoordinator assistant text", () => {
  it("preserves complete commentary and provider-visible reasoning text", async () => {
    const sink = createLifecycleSink();
    const coordinator = new RuntimeLifecycleCoordinator({
      threadId: run.threadId,
      workspaceId: run.workspaceId,
      turnId: turn.id,
      runAttemptId,
      sink,
      producerId: "runtime-assistant-text-test",
      clock: { now: () => "2026-07-18T10:00:00.000Z" },
    });
    const fullText = "visible provider text ".repeat(500);
    await coordinator.start();

    await coordinator.appendAssistantCommentary(
      ItemIdSchema.parse("itm_commentary_long001"),
      fullText,
    );
    await coordinator.appendAssistantReasoning(
      ItemIdSchema.parse("itm_reasoning_long001"),
      fullText,
      true,
    );

    const commentary = sink.events.filter(
      (event) => event.type === "assistant_message.delta",
    );
    const reasoning = sink.events.filter(
      (event) => event.type === "reasoning.summary_delta",
    );
    const payloadString = (payload: unknown, key: string): string => {
      if (!payload || typeof payload !== "object") return "";
      const value = (payload as Record<string, unknown>)[key];
      return typeof value === "string" ? value : "";
    };
    expect(
      commentary
        .map((event) => payloadString(event.payload, "delta"))
        .join(""),
    ).toBe(fullText);
    expect(
      reasoning.map((event) => payloadString(event.payload, "delta")).join(""),
    ).toBe(fullText);
    expect(
      reasoning.every(
        (event) =>
          Boolean(event.payload) &&
          typeof event.payload === "object" &&
          (event.payload as unknown as Record<string, unknown>).displaySafe ===
            true,
      ),
    ).toBe(true);
  });

  it("continues to discard provider reasoning not designated display safe", async () => {
    const sink = createLifecycleSink();
    const coordinator = new RuntimeLifecycleCoordinator({
      threadId: run.threadId,
      workspaceId: run.workspaceId,
      turnId: turn.id,
      runAttemptId,
      sink,
      producerId: "runtime-assistant-text-test",
      clock: { now: () => "2026-07-18T10:00:00.000Z" },
    });
    await coordinator.start();

    await coordinator.appendAssistantReasoning(
      ItemIdSchema.parse("itm_reasoning_private001"),
      "Private provider reasoning",
      false,
    );

    expect(sink.events.some((event) => event.type === "reasoning.summary_delta"))
      .toBe(false);
  });
});
