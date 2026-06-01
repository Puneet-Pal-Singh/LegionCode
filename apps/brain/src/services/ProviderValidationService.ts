/**
 * ProviderValidationService - Preflight validation for LLM provider configuration
 *
 * This service runs preflight checks on the environment configuration before
 * attempting to initialize LLM providers. It provides:
 * 1. Early detection of missing configuration (fail-fast)
 * 2. Structured error messages suitable for UI diagnostics
 * 3. Clear actionable guidance for misconfiguration
 *
 * Design: Runs at startup and before chat execution to prevent 500 errors
 * with missing or invalid provider configuration.
 */

import type { Env } from "../types/ai";
import { SUPPORTED_DEFAULT_PROVIDERS } from "./ai/ProviderAdapterFactory";

export interface ValidationError {
  code: string;
  message: string;
  severity: "error" | "warning";
  hint: string;
}

export interface ProviderValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
}

interface ProviderValidationOptions {
  activeProviderId?: string;
}

export class ProviderValidationService {
  /**
   * Validate provider configuration for the given environment
   * Returns structured errors that can be presented to users
   *
   * - Provider API keys are optional (with warnings)
   * - Unknown providers are accepted with warnings (extensible for BYOK/custom)
   * - Only truly critical configuration (security, encryption) blocks startup
   * - Provider selection must be explicit or use platform defaults
   */
  static validate(
    env: Env,
    options?: ProviderValidationOptions,
  ): ProviderValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationError[] = [];

    // Validate critical security configuration (always required)
    this.validateCriticalSecurity(env, errors);

    // Provider validation: known providers get specific checks, unknown get warnings
    const provider = (env.LLM_PROVIDER ?? "litellm").trim().toLowerCase();
    const activeProviderId = options?.activeProviderId?.trim().toLowerCase();
    const providerToValidate =
      activeProviderId && activeProviderId.length > 0
        ? activeProviderId
        : provider;

    // Check provider configuration
    switch (providerToValidate) {
      case "litellm":
        this.validateLiteLLMOptional(env, errors, warnings);
        break;
      case "openai":
        this.validateOpenAIOptional(env, errors, warnings);
        break;
      case "anthropic":
        this.validateAnthropicOptional(env, errors, warnings);
        break;
      // BYOK/runtime-selected providers (for example axis/openrouter/groq)
      // are validated when credentials are resolved; skip default-provider env warnings here.
      case "axis":
      case "openrouter":
      case "groq":
      case "google":
      case "together":
      case "cerebras":
      case "mistral":
      case "opencode-go":
      case "opencode-zen":
        break;
      case "cohere":
        errors.push({
          code: "UNSUPPORTED_PROVIDER",
          message: 'LLM_PROVIDER "cohere" is not executable yet',
          severity: "error",
          hint: "Cohere remains hidden until the custom-http runtime lane is wired.",
        });
        break;
      default:
        if (activeProviderId) {
          break;
        }
        errors.push({
          code: "UNKNOWN_PROVIDER",
          message: `Unknown LLM_PROVIDER "${providerToValidate}"`,
          severity: "error",
          hint: `Supported providers: ${SUPPORTED_DEFAULT_PROVIDERS.join(", ")}. For other providers, use BYOK configuration.`,
        });
        break;
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate critical security and encryption configuration
   * These always block startup
   */
  private static validateCriticalSecurity(
    env: Env,
    errors: ValidationError[],
  ): void {
    // Session security
    if (!env.SESSION_SECRET) {
      errors.push({
        code: "MISSING_SESSION_SECRET",
        message: "SESSION_SECRET is required for session encryption",
        severity: "error",
        hint: "Set SESSION_SECRET in your environment or .dev.vars file",
      });
    }

    // GitHub OAuth
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
      errors.push({
        code: "MISSING_GITHUB_OAUTH",
        message: "GitHub OAuth credentials are required",
        severity: "error",
        hint: "Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET",
      });
    }

    // BYOK credential encryption (required for credential persistence)
    if (!env.BYOK_CREDENTIAL_ENCRYPTION_KEY) {
      errors.push({
        code: "MISSING_BYOK_ENCRYPTION_KEY",
        message:
          "BYOK_CREDENTIAL_ENCRYPTION_KEY is required for credential storage",
        severity: "error",
        hint: "Set BYOK_CREDENTIAL_ENCRYPTION_KEY for encrypted BYOK credential persistence",
      });
    }
  }

  /**
   * Get a human-readable summary of validation errors
   * Suitable for logging and API error responses
   */
  static formatErrors(result: ProviderValidationResult): string {
    if (result.valid) {
      return "";
    }

    const lines: string[] = [];
    lines.push("Provider configuration validation failed:");
    lines.push("");

    for (const error of result.errors) {
      lines.push(`✗ [${error.code}] ${error.message}`);
      lines.push(`  Hint: ${error.hint}`);
      lines.push("");
    }

    if (result.warnings.length > 0) {
      lines.push("Warnings:");
      for (const warning of result.warnings) {
        lines.push(`⚠ [${warning.code}] ${warning.message}`);
        lines.push(`  Hint: ${warning.hint}`);
        lines.push("");
      }
    }

    return lines.join("\n");
  }

  /**
   * Validate LiteLLM provider configuration (optional)
   * Missing keys are reported as warnings.
   */
  private static validateLiteLLMOptional(
    env: Env,
    _errors: ValidationError[],
    warnings: ValidationError[],
  ): void {
    if (!env.LITELLM_BASE_URL) {
      warnings.push({
        code: "MISSING_LITELLM_BASE_URL",
        message: "LITELLM_BASE_URL not configured",
        severity: "warning",
        hint: "Set LITELLM_BASE_URL to an explicit OpenAI-compatible endpoint.",
      });
    }

    const hasGroqKey = !!env.GROQ_API_KEY;
    const hasOpenRouterKey = !!env.OPENROUTER_API_KEY;
    const hasOpenAIKey = !!env.OPENAI_API_KEY;

    if (!hasGroqKey && !hasOpenRouterKey && !hasOpenAIKey) {
      warnings.push({
        code: "MISSING_LITELLM_KEYS",
        message: "LiteLLM provider keys not configured",
        severity: "warning",
        hint: "Set a key matching your configured LITELLM_BASE_URL host (OPENAI_API_KEY, OPENROUTER_API_KEY, or GROQ_API_KEY).",
      });
    }

    if (!env.DEFAULT_MODEL) {
      warnings.push({
        code: "NO_DEFAULT_MODEL",
        message: "DEFAULT_MODEL not set",
        severity: "warning",
        hint: "Set DEFAULT_MODEL for explicit model selection.",
      });
    }
  }

  /**
   * Validate OpenAI provider configuration (optional)
   * Missing keys are reported as warnings.
   */
  private static validateOpenAIOptional(
    env: Env,
    _errors: ValidationError[],
    warnings: ValidationError[],
  ): void {
    if (!env.OPENAI_API_KEY) {
      warnings.push({
        code: "MISSING_OPENAI_API_KEY",
        message: "OPENAI_API_KEY not configured",
        severity: "warning",
        hint: "Set OPENAI_API_KEY for direct OpenAI access.",
      });
    }

    if (!env.DEFAULT_MODEL) {
      warnings.push({
        code: "NO_DEFAULT_MODEL",
        message: "DEFAULT_MODEL not set",
        severity: "warning",
        hint: "Set DEFAULT_MODEL for explicit model selection (e.g., gpt-4).",
      });
    }
  }

  /**
   * Validate Anthropic provider configuration (optional)
   * Missing keys are reported as warnings.
   */
  private static validateAnthropicOptional(
    env: Env,
    _errors: ValidationError[],
    warnings: ValidationError[],
  ): void {
    if (!env.ANTHROPIC_API_KEY) {
      warnings.push({
        code: "MISSING_ANTHROPIC_API_KEY",
        message: "ANTHROPIC_API_KEY not configured",
        severity: "warning",
        hint: "Set ANTHROPIC_API_KEY for direct Anthropic access.",
      });
    }

    if (!env.DEFAULT_MODEL) {
      warnings.push({
        code: "NO_DEFAULT_MODEL",
        message: "DEFAULT_MODEL not set",
        severity: "warning",
        hint: "Set DEFAULT_MODEL for explicit model selection (e.g., claude-3-sonnet-20240229).",
      });
    }
  }
}
