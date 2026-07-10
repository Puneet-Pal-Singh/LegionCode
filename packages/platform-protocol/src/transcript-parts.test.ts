import { describe, expect, it } from "vitest";
import {
  TranscriptPartSchema,
  projectVisibleTranscriptText,
  replayTranscriptPartEvents,
} from "./transcript-parts.js";

const base = {
  schemaVersion: 1 as const,
  runId: "run_1",
  turnId: "turn_1",
  createdAt: "2026-07-10T00:00:00.000Z",
};

describe("typed transcript parts", () => {
  it("accepts visible and audit-only parts while keeping visibility typed", () => {
    const visible = TranscriptPartSchema.parse({
      ...base,
      id: "part_visible",
      sequence: 0,
      type: "visible_text",
      visibility: "visible",
      text: "Done.",
      finalized: false,
    });
    const reasoning = TranscriptPartSchema.parse({
      ...base,
      id: "part_reasoning",
      sequence: 1,
      type: "reasoning",
      visibility: "audit_only",
      text: "private plan",
    });

    expect(projectVisibleTranscriptText([visible, reasoning])).toBe("Done.");
  });

  it("replays created, delta, and completed events into the live-equivalent parts", () => {
    const created = {
      ...base,
      id: "part_visible",
      sequence: 0,
      type: "visible_text" as const,
      visibility: "visible" as const,
      text: "Done",
      finalized: false,
    };
    const completed = { ...created, text: "Done." };
    const live = [completed];
    const replayed = replayTranscriptPartEvents([
      { type: "transcript_part.created", schemaVersion: 1, part: created },
      {
        type: "transcript_part.delta",
        schemaVersion: 1,
        partId: created.id,
        runId: created.runId,
        turnId: created.turnId,
        sequence: 1,
        createdAt: created.createdAt,
        target: "visible_text",
        delta: ".",
      },
      { type: "transcript_part.completed", schemaVersion: 1, part: completed },
    ]);

    expect(replayed).toEqual(live);
    expect(projectVisibleTranscriptText(replayed)).toBe("Done.");
  });

  it("cannot project reasoning, tools, usage, errors, or raw provider material", () => {
    const parts = [
      {
        ...base,
        id: "reasoning",
        sequence: 0,
        type: "reasoning" as const,
        visibility: "audit_only" as const,
        text: "User says: private plan",
      },
      {
        ...base,
        id: "raw",
        sequence: 1,
        type: "raw_provider_material" as const,
        visibility: "audit_only" as const,
        providerId: "legacy-provider",
        format: "provider-json",
        material: { text: "Direct Answer: hidden" },
      },
    ];

    expect(projectVisibleTranscriptText(parts)).toBe("");
  });
});
