import { describe, it, expect } from "vitest";
import { ContextBuilder } from "../src/ContextBuilder.js";
import type {
  ContextBuildInput,
  AgentDescriptor,
  ToolDescriptor,
} from "@legioncode/context-assembly";

describe("ContextBuilder", () => {
  const createMockInput = (
    overrides: Partial<ContextBuildInput> = {},
  ): ContextBuildInput => ({
    runId: "test-run-123" as string & { __brand: "RunId" },
    goal: { raw: "Test goal" },
    agent: {
      id: "test-agent",
      role: "coder",
      capabilities: ["read_files", "write_files"],
    },
    constraints: {
      maxTokens: 4000,
      strategy: "balanced",
      allowSummarization: false,
    },
    ...overrides,
  });

  describe("determinism", () => {
    it("should produce identical output for identical input", async () => {
      const builder = new ContextBuilder();
      const input = createMockInput();

      const result1 = await builder.build(input);
      const result2 = await builder.build(input);

      expect(result1.system).toBe(result2.system);
      expect(result1.messages).toEqual(result2.messages);
      expect(result1.tokenEstimate).toBe(result2.tokenEstimate);
    });

    it("should produce consistent token estimates", async () => {
      const builder = new ContextBuilder();
      const input = createMockInput();

      const result1 = await builder.build(input);
      const result2 = await builder.build(input);
      const result3 = await builder.build(input);

      expect(result1.tokenEstimate).toBe(result2.tokenEstimate);
      expect(result2.tokenEstimate).toBe(result3.tokenEstimate);
    });
  });

  describe("budget enforcement", () => {
    it("should respect maxTokens constraint", async () => {
      const builder = new ContextBuilder();
      const input = createMockInput({
        constraints: {
          maxTokens: 100,
          strategy: "balanced",
          allowSummarization: false,
        },
      });

      const result = await builder.build(input);

      expect(result.tokenEstimate).toBeLessThanOrEqual(100);
    });

    it("should track remaining budget in debug info", async () => {
      const builder = new ContextBuilder();
      const input = createMockInput({
        constraints: {
          maxTokens: 4000,
          strategy: "balanced",
          allowSummarization: false,
        },
      });

      const result = await builder.build(input);

      expect(result.debug).toBeDefined();
      expect(result.debug!.tokenBreakdown.remaining).toBeGreaterThanOrEqual(0);
    });

    it("should throw when system prompt exceeds budget", async () => {
      const builder = new ContextBuilder();
      const input = createMockInput({
        constraints: {
          maxTokens: 10,
          strategy: "balanced",
          allowSummarization: false,
        },
      });

      await expect(builder.build(input)).rejects.toThrow(
        "System prompt exceeds token budget",
      );
    });
  });

  describe("empty input", () => {
    it("should handle input with no repo, memory, or events", async () => {
      const builder = new ContextBuilder();
      const input = createMockInput();

      const result = await builder.build(input);

      expect(result.system).toContain("System Instructions");
      expect(result.messages).toHaveLength(0);
      expect(result.tools).toHaveLength(0);
      expect(result.tokenEstimate).toBeGreaterThan(0);
    });

    it("should produce valid output with minimal input", async () => {
      const builder = new ContextBuilder();
      const input = createMockInput({
        goal: { raw: "" },
        agent: {
          id: "minimal",
          role: "generic",
          capabilities: [],
        },
      });

      const result = await builder.build(input);

      expect(result.system).toBeDefined();
      expect(result.messages).toBeDefined();
      expect(result.tools).toBeDefined();
      expect(result.tokenEstimate).toBeGreaterThanOrEqual(0);
    });
  });

  describe("tool filtering", () => {
    it("should filter tools by agent capabilities", async () => {
      const tools: ToolDescriptor[] = [
        {
          name: "readFile",
          description: "Read a file",
          schema: {},
          requiredCapabilities: ["read_files"],
        },
        {
          name: "writeFile",
          description: "Write a file",
          schema: {},
          requiredCapabilities: ["write_files"],
        },
        {
          name: "executeCode",
          description: "Execute code",
          schema: {},
          requiredCapabilities: ["execute_code"],
        },
      ];

      const builder = new ContextBuilder({ tools });
      const input = createMockInput({
        agent: {
          id: "limited",
          role: "coder",
          capabilities: ["read_files"],
        },
      });

      const result = await builder.build(input);

      expect(result.tools).toHaveLength(1);
      expect(result.tools[0].name).toBe("readFile");
    });
  });
});
