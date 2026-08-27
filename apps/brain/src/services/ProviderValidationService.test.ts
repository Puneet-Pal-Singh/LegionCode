import { describe, it, expect } from "vitest";
import { ProviderValidationService } from "./ProviderValidationService";
import type { Env } from "../types/ai";

// Helper to add required security config
const withSecurityConfig = (env: Partial<Env>): Env => ({
  SESSION_SECRET: "test-session-secret",
  GITHUB_CLIENT_ID: "test-github-id",
  GITHUB_CLIENT_SECRET: "test-github-secret",
  BYOK_CREDENTIAL_ENCRYPTION_KEY: "test-encryption-key",
  ...env,
});

const baseEnv: Env = withSecurityConfig({
  OPENAI_API_KEY: "test-api-key",
  DEFAULT_MODEL: "gpt-4",
});

describe("ProviderValidationService", () => {
  describe("LiteLLM validation", () => {
    it("should pass with GROQ_API_KEY and DEFAULT_MODEL", () => {
      const env = withSecurityConfig({
        GROQ_API_KEY: "test-key",
        DEFAULT_MODEL: "llama-3.3-70b-versatile",
        LLM_PROVIDER: "litellm",
      });

      const result = ProviderValidationService.validate(env);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should pass with OPENAI_API_KEY and DEFAULT_MODEL", () => {
      const env = withSecurityConfig({
        OPENAI_API_KEY: "test-api-key",
        DEFAULT_MODEL: "gpt-4",
        LLM_PROVIDER: "litellm",
      });

      const result = ProviderValidationService.validate(env);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should pass with OPENROUTER_API_KEY and DEFAULT_MODEL", () => {
      const env = withSecurityConfig({
        OPENROUTER_API_KEY: "sk-or-v1-test",
        DEFAULT_MODEL: "arcee-ai/trinity-large-preview:free",
        LLM_PROVIDER: "litellm",
      });

      const result = ProviderValidationService.validate(env);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings.some((w) => w.code === "MISSING_LITELLM_KEYS")).toBe(
        false,
      );
    });

    it("should warn (not error) without API key", () => {
      const env = withSecurityConfig({
        DEFAULT_MODEL: "llama-3.3-70b-versatile",
        LLM_PROVIDER: "litellm",
      });

      const result = ProviderValidationService.validate(env);
      // Valid because API keys are now optional
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      // But should have a warning
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings.some((w) => w.code === "MISSING_LITELLM_KEYS")).toBe(
        true,
      );
    });

    it("should warn (not error) without DEFAULT_MODEL", () => {
      const env = withSecurityConfig({
        GROQ_API_KEY: "test-key",
        LLM_PROVIDER: "litellm",
      });

      const result = ProviderValidationService.validate(env);
      // Valid because DEFAULT_MODEL is now optional
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      // Should have warning for missing DEFAULT_MODEL
      const warnings = result.warnings.map((w) => w.code);
      expect(warnings).toContain("NO_DEFAULT_MODEL");
    });

    it("should warn (not error) when both API key and DEFAULT_MODEL missing", () => {
      const env = withSecurityConfig({
        LLM_PROVIDER: "litellm",
      });

      const result = ProviderValidationService.validate(env);
      // Valid because provider keys are optional
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      // Should have warnings for both
      const warningCodes = result.warnings.map((w) => w.code).sort();
      expect(warningCodes).toContain("MISSING_LITELLM_KEYS");
      expect(warningCodes).toContain("NO_DEFAULT_MODEL");
    });

    it("should warn about missing API keys but pass validation", () => {
      const env = withSecurityConfig({
        GROQ_API_KEY: "test-key",
        LLM_PROVIDER: "litellm",
      });

      const result = ProviderValidationService.validate(env);
      // Valid because API keys are optional
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe("OpenAI validation", () => {
    it("should pass with OPENAI_API_KEY", () => {
      const env = withSecurityConfig({
        OPENAI_API_KEY: "test-api-key",
        DEFAULT_MODEL: "gpt-4",
        LLM_PROVIDER: "openai",
      });

      const result = ProviderValidationService.validate(env);
      expect(result.valid).toBe(true);
    });

    it("should warn (not error) without OPENAI_API_KEY", () => {
      const env = withSecurityConfig({
        DEFAULT_MODEL: "gpt-4",
        LLM_PROVIDER: "openai",
      });

      const result = ProviderValidationService.validate(env);
      // Valid because API keys are now optional
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      // But should warn about missing key
      expect(result.warnings.some((w) => w.code === "MISSING_OPENAI_API_KEY")).toBe(true);
    });

    it("should warn without DEFAULT_MODEL for OpenAI", () => {
      const env = withSecurityConfig({
        OPENAI_API_KEY: "test-api-key",
        LLM_PROVIDER: "openai",
      });

      const result = ProviderValidationService.validate(env);
      expect(result.valid).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings.some((w) => w.code === "NO_DEFAULT_MODEL")).toBe(true);
    });
  });

  describe("Anthropic validation", () => {
    it("should pass with ANTHROPIC_API_KEY", () => {
      const env = withSecurityConfig({
        ANTHROPIC_API_KEY: "test-api-key",
        DEFAULT_MODEL: "claude-3-sonnet-20240229",
        LLM_PROVIDER: "anthropic",
      });

      const result = ProviderValidationService.validate(env);
      expect(result.valid).toBe(true);
    });

    it("should warn (not error) without ANTHROPIC_API_KEY", () => {
      const env = withSecurityConfig({
        DEFAULT_MODEL: "claude-3-sonnet-20240229",
        LLM_PROVIDER: "anthropic",
      });

      const result = ProviderValidationService.validate(env);
      // Valid because API keys are now optional
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      // But should warn about missing key
      expect(result.warnings.some((w) => w.code === "MISSING_ANTHROPIC_API_KEY")).toBe(true);
    });
  });

  describe("Expanded BYOK provider validation", () => {
    it("accepts google as a known runtime-selected provider", () => {
      const result = ProviderValidationService.validate(
        withSecurityConfig({
          LLM_PROVIDER: "google",
        }),
      );

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("accepts together, cerebras, and mistral as known BYOK providers", () => {
      const providerIds = ["together", "cerebras", "mistral"] as const;

      for (const providerId of providerIds) {
        const result = ProviderValidationService.validate(
          withSecurityConfig({
            LLM_PROVIDER: providerId,
          }),
        );

        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      }
    });

    it("rejects cohere because the runtime lane is not wired yet", () => {
      const result = ProviderValidationService.validate(
        withSecurityConfig({
          LLM_PROVIDER: "cohere",
        }),
      );

      expect(result.valid).toBe(false);
      expect(
        result.errors.some((error) => error.code === "UNSUPPORTED_PROVIDER"),
      ).toBe(true);
    });
  });

  describe("Error formatting", () => {
    it("should format errors as readable message when critical config missing", () => {
      const env: Env = {
        LLM_PROVIDER: "litellm",
        // Missing SESSION_SECRET and other critical security keys
      };

      const result = ProviderValidationService.validate(env);
      const formatted = ProviderValidationService.formatErrors(result);

      // Should have errors for critical security config
      expect(result.errors.length).toBeGreaterThan(0);
      expect(formatted).toContain("validation failed");
      expect(formatted).toContain("SESSION_SECRET");
      expect(formatted).toContain("Hint:");
    });

    it("should return empty string for valid config", () => {
      const result = ProviderValidationService.validate(baseEnv);
      const formatted = ProviderValidationService.formatErrors(result);
      expect(formatted).toBe("");
    });
  });

  describe("Default provider (OpenAI)", () => {
    it("should validate as OpenAI when LLM_PROVIDER not set", () => {
      const env: Env = {
        ...baseEnv,
        // LLM_PROVIDER not set, should default to openai
      };

      const result = ProviderValidationService.validate(env);
      expect(result.valid).toBe(true);
    });
  });
});
