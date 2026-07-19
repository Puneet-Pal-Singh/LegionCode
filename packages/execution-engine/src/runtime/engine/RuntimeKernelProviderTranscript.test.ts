import { describe, expect, it } from "vitest";
import { RuntimeKernelError } from "@repo/runtime-kernel";
import { RuntimeKernelProviderTranscript } from "./RuntimeKernelProviderTranscript.js";

describe("RuntimeKernelProviderTranscript", () => {
  it("promotes an ordinary terminal provider reply to typed final evidence", () => {
    const transcript = new RuntimeKernelProviderTranscript();

    const terminal = transcript.complete([
      {
        id: "provider-visible",
        schemaVersion: 1,
        runId: "run-1",
        turnId: "turn-1",
        sequence: 0,
        createdAt: "2026-07-18T00:00:00.000Z",
        type: "visible_text",
        visibility: "visible",
        text: "Hello! How can I help?",
        finalized: false,
      },
    ]);

    expect(terminal.text).toBe("Hello! How can I help?");
    expect(terminal.parts).toEqual([
      expect.objectContaining({
        type: "final",
        visibility: "visible",
        text: "Hello! How can I help?",
      }),
    ]);
    expect(transcript.readFinalParts()).toEqual(terminal.parts);
  });

  it("fails the kernel boundary when no model-written final exists", () => {
    const transcript = new RuntimeKernelProviderTranscript();

    expect(() =>
      transcript.complete([
        {
          id: "provider-reasoning",
          schemaVersion: 1,
          runId: "run-1",
          turnId: "turn-1",
          sequence: 0,
          createdAt: "2026-07-18T00:00:00.000Z",
          type: "reasoning",
          visibility: "audit_only",
          text: "Internal model material",
        },
      ]),
    ).toThrowError(
      expect.objectContaining<Partial<RuntimeKernelError>>({
        code: "model_final_missing",
      }),
    );
    expect(transcript.readFinalParts()).toEqual([]);
  });
});
