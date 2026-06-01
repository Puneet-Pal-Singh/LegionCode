import type { CoreMessage } from "ai";
import { z } from "zod";
import type { RepositoryContext } from "../types.js";
import type { Run } from "../run/index.js";
import type { ILLMGateway } from "../llm/index.js";

const TURN_MODE_SCHEMA = z.object({
  mode: z.enum(["chat", "action"]),
  rationale: z.string().max(400).optional(),
  confidence: z.number().min(0).max(1),
});
const ACTION_CONFIDENCE_THRESHOLD = 0.8;
const ACTION_HEURISTIC_PATTERNS = [
  /\b(read|open|show|inspect|diff|grep|search|find|list|ls|tree)\b.*\b(file|files|repo|repository|directory|folder|path)\b/i,
  /\b(edit|write|update|modify|rename|delete|remove|create|add)\b.*\b(file|files|repo|repository|directory|folder|path)\b/i,
  /\b(run|execute|test|build|lint|typecheck)\b/i,
  /\b(git status|git diff|git log|git show|git grep|pnpm\b|npm\b|yarn\b|bun\b|node\b|rg\b|grep\b|find\b|ls\b|cat\b|sed\b)\b/i,
  /(?:^|[\s`'"])(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|json|md|yml|yaml|toml|py|rs|go|sh)(?:[\s`'"]|$)/i,
] as const;

export type TurnMode = z.infer<typeof TURN_MODE_SCHEMA>["mode"];
export interface TurnModeDecision {
  mode: TurnMode;
  source: "heuristic" | "llm" | "recovered";
  rationale?: string;
  confidence?: number;
}

interface DetermineTurnModeInput {
  llmGateway: ILLMGateway;
  run: Run;
  prompt: string;
  messages: CoreMessage[];
  repositoryContext?: RepositoryContext;
}

export async function determineTurnMode({
  llmGateway,
  run,
  prompt,
  messages,
  repositoryContext,
}: DetermineTurnModeInput): Promise<TurnModeDecision> {
  const heuristicDecision = detectHeuristicActionTurn(prompt);
  if (heuristicDecision) {
    return heuristicDecision;
  }

  const classifierMessages = buildTurnModeMessages(
    prompt,
    messages,
    repositoryContext,
  );

  const result = await llmGateway.generateStructured({
    context: {
      runId: run.id,
      sessionId: run.sessionId,
      agentType: run.agentType,
      phase: "planning",
    },
    schema: TURN_MODE_SCHEMA,
    messages: classifierMessages,
    model: run.input.modelId,
    providerId: run.input.providerId,
    runtimeModelId: run.input.runtimeModelId,
    providerTransport: run.input.providerTransport,
    providerEndpoint: run.input.providerEndpoint,
    temperature: 0,
  });

  const mode = result.object.mode === "chat" ? "chat" : "action";
  const confidence =
    typeof result.object.confidence === "number" ? result.object.confidence : 1;
  if (mode === "action" && confidence < ACTION_CONFIDENCE_THRESHOLD) {
    return {
      mode: "chat",
      source: "llm",
      rationale: result.object.rationale,
      confidence,
    };
  }
  return {
    mode,
    source: "llm",
    rationale: result.object.rationale,
    confidence,
  };
}

function detectHeuristicActionTurn(prompt: string): TurnModeDecision | null {
  const normalizedPrompt = prompt.trim();
  if (normalizedPrompt.length === 0) {
    return null;
  }

  for (const pattern of ACTION_HEURISTIC_PATTERNS) {
    if (pattern.test(normalizedPrompt)) {
      return {
        mode: "action",
        source: "heuristic",
        rationale: "Matched explicit repository/file/command heuristic.",
        confidence: 1,
      };
    }
  }

  return null;
}

function buildTurnModeMessages(
  prompt: string,
  messages: CoreMessage[],
  repositoryContext?: RepositoryContext,
): Array<{ role: "system" | "user"; content: string }> {
  const recentTurns = messages
    .slice(-8)
    .map((message) => formatTurnModeMessage(message))
    .filter((line) => line.length > 0);

  const repositoryLine =
    repositoryContext?.owner && repositoryContext?.repo
      ? `Repository selection: ${repositoryContext.owner}/${repositoryContext.repo}${repositoryContext.branch ? `@${repositoryContext.branch}` : ""}.`
      : "Repository selection: none.";

  return [
    {
      role: "system",
      content: [
        "Classify the user's latest request into a turn mode.",
        'Return "chat" when the request is conversational (greeting, Q&A, general explanation, capability question) and does not require repository/tool execution.',
        'Return "action" when the request requires reading/modifying repository files, running commands, or any tool execution.',
        "Set confidence to a decimal between 0 and 1. Use >=0.8 only when the request clearly requires tools/files/commands.",
        "For single-word greetings or conversational pleasantries, choose chat with high confidence.",
        "Use the recent conversation and repository selection for context when the latest request is brief (for example: continue, do it, same repo).",
        "Respond strictly with schema-compliant JSON.",
      ].join(" "),
    },
    {
      role: "user",
      content: [
        repositoryLine,
        "Recent conversation:",
        recentTurns.join("\n") || "(none)",
        "Latest user request:",
        prompt,
      ].join("\n"),
    },
  ];
}

function formatTurnModeMessage(message: CoreMessage): string {
  const role = message.role.toUpperCase();
  const content = extractTurnModeMessageContent(message.content);
  if (!content) {
    return "";
  }
  return `${role}: ${content}`;
}

function extractTurnModeMessageContent(
  content: CoreMessage["content"],
): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (!part || typeof part !== "object") {
        return "";
      }

      const candidate = part as unknown as Record<string, unknown>;
      if (typeof candidate.text === "string") {
        return candidate.text;
      }
      if (typeof candidate.content === "string") {
        return candidate.content;
      }
      return "";
    })
    .filter((text) => text.trim().length > 0)
    .join("\n")
    .trim();
}
