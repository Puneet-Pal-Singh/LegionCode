import type { CoreMessage } from "ai";
import { z } from "zod";
import type { Run } from "../run/index.js";
import type { ILLMGateway } from "../llm/index.js";
import { recordLifecycleStep } from "./RunMetadataPolicy.js";

const ReviewerDecisionSchema = z.object({
  verdict: z.enum(["accept", "request_changes", "fail"]),
  summary: z.string().trim().min(1),
  issues: z.array(z.string().trim().min(1)).max(10).default([]),
});

type ReviewerDecision = z.infer<typeof ReviewerDecisionSchema>;

interface ReviewerPassParams {
  run: Run;
  originalPrompt: string;
  synthesisOutput: string;
  llmGateway: ILLMGateway;
}

export async function applyReviewerPassIfEnabled({
  run,
  originalPrompt,
  synthesisOutput,
  llmGateway,
}: ReviewerPassParams): Promise<string> {
  if (!isReviewerPassEnabled(run.input.metadata)) {
    setReviewerPassDisabled(run);
    return synthesisOutput;
  }

  console.log(`[run/engine] Reviewer pass enabled for run ${run.id}`);
  const decision = await generateReviewerDecision(
    run,
    originalPrompt,
    synthesisOutput,
    llmGateway,
  );
  if (!decision) {
    return synthesisOutput;
  }

  recordReviewerDecision(run, decision);
  if (decision.verdict === "accept") {
    return synthesisOutput;
  }

  recordLifecycleStep(run, "SYNTHESIS", `reviewer=${decision.verdict}`);
  return `${synthesisOutput}\n\n${formatReviewerSuffix(decision)}`;
}

function setReviewerPassDisabled(run: Run): void {
  run.metadata.reviewerPass = {
    enabled: false,
    applied: false,
  };
}

async function generateReviewerDecision(
  run: Run,
  originalPrompt: string,
  synthesisOutput: string,
  llmGateway: ILLMGateway,
): Promise<ReviewerDecision | null> {
  try {
    const reviewResult = await llmGateway.generateStructured({
      context: {
        runId: run.id,
        sessionId: run.sessionId,
        agentType: "review",
        phase: "synthesis",
      },
      messages: buildReviewerMessages(originalPrompt, synthesisOutput),
      schema: ReviewerDecisionSchema,
      model: run.input.modelId,
      providerId: run.input.providerId,
      runtimeModelId: run.input.runtimeModelId,
      providerTransport: run.input.providerTransport,
      providerEndpoint: run.input.providerEndpoint,
      temperature: 0.1,
    });
    return {
      ...reviewResult.object,
      issues: reviewResult.object.issues ?? [],
    };
  } catch (error) {
    recordReviewerPassFailure(run, error);
    return null;
  }
}

function buildReviewerMessages(
  originalPrompt: string,
  synthesisOutput: string,
): CoreMessage[] {
  return [
    {
      role: "system",
      content:
        "Review the candidate response for correctness and regressions. Return a strict verdict and concise review notes.",
    },
    {
      role: "user",
      content: [
        "Original user request:",
        originalPrompt,
        "",
        "Candidate synthesis output:",
        synthesisOutput,
      ].join("\n"),
    },
  ];
}

function recordReviewerDecision(run: Run, decision: ReviewerDecision): void {
  run.metadata.reviewerPass = {
    enabled: true,
    verdict: decision.verdict,
    summary: decision.summary,
    issues: decision.issues,
    reviewedAt: new Date().toISOString(),
    applied: decision.verdict !== "accept",
  };
}

function recordReviewerPassFailure(run: Run, error: unknown): void {
  const message =
    error instanceof Error ? error.message : "reviewer pass failed";
  run.metadata.reviewerPass = {
    enabled: true,
    verdict: "fail",
    summary: "Reviewer pass failed; returning generator output.",
    issues: [],
    reviewedAt: new Date().toISOString(),
    applied: false,
    error: message,
  };
  console.warn(
    `[run/engine] Reviewer pass failed for run ${run.id}: ${message}`,
  );
}

function formatReviewerSuffix(decision: ReviewerDecision): string {
  const issueLines =
    decision.issues.length > 0
      ? decision.issues
          .map((issue, index) => `${index + 1}. ${issue}`)
          .join("\n")
      : "1. No detailed issue list provided by reviewer.";

  return [
    "---",
    `Reviewer Note (${decision.verdict})`,
    decision.summary,
    "",
    "Reviewer Issues:",
    issueLines,
  ].join("\n");
}

function isReviewerPassEnabled(metadata?: Record<string, unknown>): boolean {
  if (!metadata) {
    return false;
  }

  const directFlag = metadata.reviewerPassV1;
  if (typeof directFlag === "boolean") {
    return directFlag;
  }

  const featureFlags = metadata.featureFlags;
  if (typeof featureFlags !== "object" || featureFlags === null) {
    return false;
  }

  const nestedFlag = (featureFlags as Record<string, unknown>).reviewerPassV1;
  return typeof nestedFlag === "boolean" ? nestedFlag : false;
}
