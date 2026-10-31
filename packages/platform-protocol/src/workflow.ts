import { z } from "zod";

export const WORKFLOW_INTENTS = {
  EXPLORE: "explore",
  BUILD: "build",
  REVIEW: "review",
  SHIP: "ship",
} as const;

export const WorkflowIntentSchema = z.enum([
  WORKFLOW_INTENTS.EXPLORE,
  WORKFLOW_INTENTS.BUILD,
  WORKFLOW_INTENTS.REVIEW,
  WORKFLOW_INTENTS.SHIP,
]);
export type WorkflowIntent = z.infer<typeof WorkflowIntentSchema>;

export const WORKFLOW_ENTRYPOINTS = {
  COMPOSER_SUBMIT: "composer_submit",
  REVIEW_ACTION: "review_action",
  COMMIT_ACTION: "commit_action",
  DEPLOY_ACTION: "deploy_action",
  PROVIDER_CONNECT: "provider_connect",
  OTHER: "other",
} as const;

export const WorkflowEntrypointSchema = z.enum([
  WORKFLOW_ENTRYPOINTS.COMPOSER_SUBMIT,
  WORKFLOW_ENTRYPOINTS.REVIEW_ACTION,
  WORKFLOW_ENTRYPOINTS.COMMIT_ACTION,
  WORKFLOW_ENTRYPOINTS.DEPLOY_ACTION,
  WORKFLOW_ENTRYPOINTS.PROVIDER_CONNECT,
  WORKFLOW_ENTRYPOINTS.OTHER,
]);
export type WorkflowEntrypoint = z.infer<typeof WorkflowEntrypointSchema>;
