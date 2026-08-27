// packages/execution-engine/src/runtime/types.test.ts
// Phase 4: Test repository context integration

import { describe, it, expect } from "vitest";
import type { RunInput, RepositoryContext } from "./types.js";

describe("Types - Phase 4: Repository Context", () => {
  describe("RepositoryContext", () => {
    it("should allow repository context with full metadata", () => {
      const context: RepositoryContext = {
        owner: "sourcegraph",
        repo: "legioncode",
        branch: "main",
        baseUrl: "https://github.com/sourcegraph/legioncode",
      };

      expect(context.owner).toBe("sourcegraph");
      expect(context.repo).toBe("legioncode");
      expect(context.branch).toBe("main");
      expect(context.baseUrl).toBe("https://github.com/sourcegraph/legioncode");
    });

    it("should allow partial repository context", () => {
      const context: RepositoryContext = {
        owner: "sourcegraph",
        repo: "legioncode",
      };

      expect(context.owner).toBe("sourcegraph");
      expect(context.repo).toBe("legioncode");
      expect(context.branch).toBeUndefined();
      expect(context.baseUrl).toBeUndefined();
    });

    it("should allow empty repository context", () => {
      const context: RepositoryContext = {};
      expect(context).toEqual({});
    });
  });

  describe("RunInput with Repository Context", () => {
    it("should include repository context in RunInput", () => {
      const input: RunInput = {
        mode: "build",
        agentType: "coding",
        prompt: "check README",
        sessionId: "sess-123",
        repositoryContext: {
          owner: "sourcegraph",
          repo: "legioncode",
          branch: "main",
        },
      };

      expect(input.repositoryContext).toBeDefined();
      expect(input.repositoryContext?.owner).toBe("sourcegraph");
      expect(input.repositoryContext?.repo).toBe("legioncode");
      expect(input.repositoryContext?.branch).toBe("main");
    });

    it("should allow RunInput without repository context for backward compatibility", () => {
      const input: RunInput = {
        mode: "plan",
        agentType: "review",
        prompt: "review this code",
        sessionId: "sess-456",
      };

      expect(input.repositoryContext).toBeUndefined();
    });

    it("should preserve all RunInput fields with repository context", () => {
      const input: RunInput = {
        mode: "build",
        agentType: "coding",
        prompt: "implement feature",
        sessionId: "sess-789",
        providerId: "openai",
        modelId: "gpt-4o",
        metadata: { priority: "high" },
        repositoryContext: {
          owner: "example",
          repo: "project",
          branch: "feat/new-feature",
          baseUrl: "https://github.com/example/project",
        },
      };

      expect(input.agentType).toBe("coding");
      expect(input.mode).toBe("build");
      expect(input.prompt).toBe("implement feature");
      expect(input.sessionId).toBe("sess-789");
      expect(input.providerId).toBe("openai");
      expect(input.modelId).toBe("gpt-4o");
      expect(input.metadata).toEqual({ priority: "high" });
      expect(input.repositoryContext?.owner).toBe("example");
      expect(input.repositoryContext?.repo).toBe("project");
    });
  });

  describe("Repository context usage patterns", () => {
    it("should support detecting repository availability", () => {
      const withRepo: RunInput = {
        mode: "build",
        agentType: "coding",
        prompt: "check README",
        sessionId: "sess-1",
        repositoryContext: {
          owner: "org",
          repo: "project",
        },
      };

      const withoutRepo: RunInput = {
        mode: "build",
        agentType: "coding",
        prompt: "check README",
        sessionId: "sess-2",
      };

      const hasRepo = (input: RunInput) => !!input.repositoryContext?.owner;
      expect(hasRepo(withRepo)).toBe(true);
      expect(hasRepo(withoutRepo)).toBe(false);
    });

    it("should support git clone URL construction", () => {
      const context: RepositoryContext = {
        owner: "sourcegraph",
        repo: "legioncode",
        baseUrl: "https://github.com/sourcegraph/legioncode",
      };

      const cloneUrl = `${context.baseUrl}.git`;
      expect(cloneUrl).toBe("https://github.com/sourcegraph/legioncode.git");
    });

    it("should support branch-aware workspace setup", () => {
      const contexts: RepositoryContext[] = [
        {
          owner: "org",
          repo: "proj",
          branch: "main",
        },
        {
          owner: "org",
          repo: "proj",
          branch: "develop",
        },
        {
          owner: "org",
          repo: "proj",
          branch: "feat/new-feature",
        },
      ];

      contexts.forEach((ctx) => {
        expect(ctx.branch).toBeDefined();
        expect(ctx.owner).toBe("org");
        expect(ctx.repo).toBe("proj");
      });
    });

    it("should support explicit build and plan modes", () => {
      const buildInput: RunInput = {
        mode: "build",
        agentType: "coding",
        prompt: "implement feature",
        sessionId: "sess-build",
      };
      const planInput: RunInput = {
        mode: "plan",
        agentType: "coding",
        prompt: "design the work",
        sessionId: "sess-plan",
      };

      expect(buildInput.mode).toBe("build");
      expect(planInput.mode).toBe("plan");
    });
  });
});
