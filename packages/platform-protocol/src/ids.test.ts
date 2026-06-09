import { describe, expect, it } from "vitest";
import {
  EventCursorSchema,
  ModelIdSchema,
  PlatformIdSchemas,
  ProviderIdSchema,
  RunIdSchema,
  ThreadIdSchema,
} from "./ids.js";

describe("platform protocol IDs", () => {
  it("exports the initial rebuild ID contract", () => {
    expect(Object.keys(PlatformIdSchemas).sort()).toMatchInlineSnapshot(`
      [
        "ApprovalId",
        "ArtifactId",
        "EventCursor",
        "EventId",
        "ItemId",
        "ModelId",
        "OrganizationId",
        "PermissionProfileId",
        "ProviderId",
        "RunId",
        "ThreadId",
        "ToolCallId",
        "TurnId",
        "UserId",
        "WorkerId",
        "WorkspaceId",
        "WorkspaceManifestId",
      ]
    `);
  });

  it("accepts opaque prefixed IDs for durable product entities", () => {
    expect(ThreadIdSchema.parse("thr_abc123")).toBe("thr_abc123");
    expect(RunIdSchema.parse("run_abc123")).toBe("run_abc123");
    expect(EventCursorSchema.parse("cursor_abc123")).toBe("cursor_abc123");
  });

  it("rejects missing, unprefixed, and wrong-prefixed run IDs", () => {
    expect(() => RunIdSchema.parse("")).toThrow();
    expect(() => RunIdSchema.parse("abc123")).toThrow();
    expect(() => RunIdSchema.parse("thread_abc123")).toThrow();
  });

  it("keeps provider and model identifiers flexible without accepting blanks", () => {
    expect(ProviderIdSchema.parse("openrouter")).toBe("openrouter");
    expect(ModelIdSchema.parse("z-ai/glm-4.5-air:free")).toBe(
      "z-ai/glm-4.5-air:free",
    );

    expect(() => ProviderIdSchema.parse("OpenAI")).toThrow();
    expect(() => ProviderIdSchema.parse(" openrouter ")).toThrow();
    expect(() => ModelIdSchema.parse("")).toThrow();
    expect(() => ModelIdSchema.parse(" z-ai/glm-4.5-air:free ")).toThrow();
  });
});
