import { describe, expect, it } from "vitest";
import { RUN_TERMINAL_STATES } from "@repo/shared-types";
import {
  FinalAssistantMessageService,
  isUnusableFinalAssistantText,
  normalizeFinalAssistantText,
} from "./FinalAssistantMessageService.js";

describe("FinalAssistantMessageService", () => {
  it("preserves substantive model-authored final text", () => {
    const result = new FinalAssistantMessageService().build({
      runId: "run-1",
      sessionId: "session-1",
      terminalState: RUN_TERMINAL_STATES.COMPLETED,
      modelText: "\n\nDone. I updated the requested files.\n",
    });

    expect(result.content).toBe("Done. I updated the requested files.");
    expect(result.source).toBe("model");
    expect(result.metadata).toMatchObject({
      terminalState: RUN_TERMINAL_STATES.COMPLETED,
      finalMessageSource: "model",
    });
  });

  it("builds runtime completion copy when model text is empty", () => {
    const result = new FinalAssistantMessageService().build({
      runId: "run-1",
      sessionId: "session-1",
      terminalState: RUN_TERMINAL_STATES.COMPLETED,
      modelText: "   ",
    });

    expect(result.content).toContain(
      "I finished the run, but the model did not produce a final response.",
    );
    expect(result.source).toBe("runtime");
  });

  it("rejects empty tool-shaped JSON as final assistant text", () => {
    expect(
      normalizeFinalAssistantText('{ "success": true, "output": "" }'),
    ).toBe("");
    expect(
      isUnusableFinalAssistantText('{ "success": true, "output": "" }'),
    ).toBe(true);
  });

  it("rejects tool-envelope JSON with descriptor keys as unusable", () => {
    expect(
      normalizeFinalAssistantText('{"tool":"bash","output":""}'),
    ).toBe("");
    expect(
      isUnusableFinalAssistantText('{"tool":"bash","output":""}'),
    ).toBe(true);
  });

  it("rejects hidden internal markup as final assistant text", () => {
    expect(
      normalizeFinalAssistantText(
        "<thinking>I should not show this to the user.</thinking>",
      ),
    ).toBe("");
  });

  it("strips hidden internal markup around visible final text", () => {
    expect(
      normalizeFinalAssistantText(
        "<analysis>private note</analysis>\nDone. The update is complete.",
      ),
    ).toBe("Done. The update is complete.");
  });

  it("removes leaked provider reasoning before a final-output cue", () => {
    expect(
      normalizeFinalAssistantText(
        'Looking at the previous turn, the user asked "Hey say ok?" and I responded with internal text.\n\nThe user is likely testing responsiveness.\n\nI will simply respond "ok" again, but this time without the internal monologue in the final output.ok',
      ),
    ).toBe("ok");
  });

  it("removes no-tool reasoning while preserving the user-visible answer", () => {
    expect(
      normalizeFinalAssistantText(
        "I don't need to use any tools for this.I'm doing well, thank you for asking! I'm ready to help you with your project.",
      ),
    ).toBe(
      "I'm doing well, thank you for asking! I'm ready to help you with your project.",
    );
  });

  it("extracts a direct-answer line from leaked reasoning lists", () => {
    expect(
      normalizeFinalAssistantText(
        [
          "• User wants me to read their README file and give an opinion on the project.",
          "• Constraint: I cannot claim to have analyzed files unless I actually have the tools/access to do so.",
          "• Direct answer: I'd love to take a look, but I haven't read your README yet!",
          "• Helpful details: Tell them I can access the files if they give me the go-ahead.",
          "• Draft 1 (Too robotic): I cannot read your readme because you have not provided it.",
        ].join("\n"),
      ),
    ).toBe("I'd love to take a look, but I haven't read your README yet!");
  });

  it("drops pure leaked tool-planning text instead of exposing it", () => {
    expect(
      normalizeFinalAssistantText(
        [
          "• I need to find the README file.",
          "• I should list the files in the root directory to locate the README.",
          "• Step 1: Call list_files to find the README.",
          "Self-Correction during thought process: I cannot fabricate tool execution.",
          "*Wait*, I am the LLM. I need to generate the tool calls now.",
        ].join("\n"),
      ),
    ).toBe("");
  });

  it("keeps substantive JSON instead of guessing intent", () => {
    const text = '{ "changedFiles": ["src/App.tsx"] }';

    expect(normalizeFinalAssistantText(text)).toBe(text);
    expect(isUnusableFinalAssistantText(text)).toBe(false);
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
      modelText: "Outcome: I could not finish because a required tool failed.",
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
