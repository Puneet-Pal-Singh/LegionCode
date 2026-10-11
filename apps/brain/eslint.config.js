import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

const RESTRICTED_IMPORT_RULE = [
  "error",
  {
    paths: [
      {
        name: "ai",
        importNames: ["generateText", "streamText", "generateObject"],
        message:
          "Use LLMGateway for model calls. Do not call AI SDK helpers directly outside core/llm.",
      },
    ],
    patterns: [
      {
        group: ["@ai-sdk/*"],
        message:
          "Provider SDK imports are restricted. Use core/llm/LLMGateway instead.",
      },
      {
        group: ["**/services/providers/**"],
        message:
          "Provider adapters are restricted. Use core/llm/LLMGateway instead.",
      },
      {
        group: ["**/legacy/**"],
        message:
          "Legacy code imports are restricted. This directory is scheduled for removal. See src/legacy/README.md for migration guidance.",
      },
    ],
  },
];

export default defineConfig([
  {
    ignores: [".wrangler/**"],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/**/*.test.ts",
      "src/core/llm/**/*",
      "src/services/AIService.ts",
      "src/services/providers/**/*",
      "src/runtime/**/*",
      "src/legacy/**/*",
    ],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      "no-restricted-imports": RESTRICTED_IMPORT_RULE,
    },
  },
]);
