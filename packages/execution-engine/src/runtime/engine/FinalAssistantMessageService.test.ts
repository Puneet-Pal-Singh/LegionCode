import { describe, expect, it } from "vitest";
import { RUN_TERMINAL_STATES } from "@repo/shared-types";
import {
  FinalAssistantMessageService,
  normalizeFinalAssistantText,
} from "./FinalAssistantMessageService.js";

describe("FinalAssistantMessageService", () => {
  it("does not treat raw model text as a final transcript part", () => {
    const result = new FinalAssistantMessageService().build({
      runId: "run-1",
      sessionId: "session-1",
      terminalState: RUN_TERMINAL_STATES.COMPLETED,
      runtimeText: "\n\nDone. I updated the requested files.\n",
    });

    expect(result.source).toBe("runtime");
    expect(result.metadata).toMatchObject({
      terminalState: RUN_TERMINAL_STATES.COMPLETED,
      finalMessageSource: "runtime",
    });
  });

  it("builds runtime completion copy when model text is empty", () => {
    const result = new FinalAssistantMessageService().build({
      runId: "run-1",
      sessionId: "session-1",
      terminalState: RUN_TERMINAL_STATES.COMPLETED,
      runtimeText: "   ",
    });

    expect(result.content).toContain(
      "I finished the run, but the model did not produce a final response.",
    );
    expect(result.source).toBe("runtime");
  });

  it("does not project absent typed parts", () => {
    expect(normalizeFinalAssistantText(undefined)).toBe("");
   });

  it("drops typed pure leaked tool-planning text instead of exposing it", () => {
    expect(
      normalizeFinalAssistantText([
          {
            id: "reasoning",
            schemaVersion: 1,
            runId: "run-1",
            turnId: "turn-1",
            sequence: 0,
            createdAt: "2026-07-10T00:00:00.000Z",
            type: "reasoning",
            visibility: "audit_only",
            text: [
              "I need to find the README file.",
              "I should list the files in the root directory to locate the README.",
              "I need to generate the tool calls now.",
            ].join("\n"),
          },
        ],
      ),
    ).toBe("");
  });

  it("renders explicit typed final parts", () => {
    expect(
      normalizeFinalAssistantText([
        { id: "reasoning", schemaVersion: 1, runId: "run-1", turnId: "turn-1", sequence: 0, createdAt: "2026-07-10T00:00:00.000Z", type: "reasoning", visibility: "audit_only", text: "private plan" },
        { id: "final", schemaVersion: 1, runId: "run-1", turnId: "turn-1", sequence: 1, createdAt: "2026-07-10T00:00:00.000Z", type: "final", visibility: "visible", text: "Done. I checked the requested file." },
      ]),
    ).toBe("Done. I checked the requested file.");
  });

  it("builds deterministic approval-denied copy", () => {
    const result = new FinalAssistantMessageService().build({
      runId: "run-1",
      sessionId: "session-1",
      terminalState: RUN_TERMINAL_STATES.APPROVAL_DENIED,
      metadata: { code: "APPROVAL_DENIED" },
    });

    expect(result.content).toContain(
      "I stopped because you denied the requested action.",
    );
    expect(result.metadata).toMatchObject({
      code: "APPROVAL_DENIED",
      terminalState: RUN_TERMINAL_STATES.APPROVAL_DENIED,
      finalMessageSource: "runtime",
    });
  });

  it("marks coded runtime-authored terminal messages without replacing text", () => {
    const result = new FinalAssistantMessageService().build({
      runId: "run-1",
      sessionId: "session-1",
      terminalState: RUN_TERMINAL_STATES.FAILED_TOOL,
      runtimeText: "Outcome: I could not finish because a required tool failed.",
      metadata: { code: "TOOL_EXECUTION_FAILED" },
    });

    expect(result.content).toBe(
      "Outcome: I could not finish because a required tool failed.",
    );
    expect(result.metadata).toMatchObject({
      code: "TOOL_EXECUTION_FAILED",
      finalMessageSource: "runtime",
    });
  });

  it("builds framed runtime copy when requested", () => {
    const result = new FinalAssistantMessageService().build({
      runId: "run-1",
      sessionId: "session-1",
      terminalState: RUN_TERMINAL_STATES.FAILED_RUNTIME,
      detail: "The runtime could not persist the final transcript item.",
      nextStep: "Retry the request after checking runtime logs.",
      useSummaryFrame: true,
    });

    expect(result.content).toContain(
      "Outcome: I could not finish because the runtime hit an internal error.",
    );
    expect(result.content).toContain(
      "What happened: The runtime could not persist the final transcript item.",
    );
  });
});
