import { createHostedAppServerClient } from "./appServerClient";
import type {
  CommitPayload,
  CreateBranchPayload,
  CreatePullRequestFromRunPayload,
  PushPayload,
  StageFilesRequest,
} from "@repo/shared-types";

interface GitRequestContext {
  runId: string;
  sessionId?: string;
}

function client() {
  return createHostedAppServerClient({ timeoutMs: null, maxResponseBytes: null });
}

export async function getGitStatus(context: GitRequestContext) {
  return client().getGitStatus(context);
}

export async function getGitDiff(context: GitRequestContext & { path: string; staged?: boolean }) {
  return client().getGitDiff(context);
}

export async function stageGitFiles(context: GitRequestContext & StageFilesRequest) {
  return client().stageGitFiles(context);
}

export async function commitGitChanges(context: GitRequestContext & { payload: CommitPayload }) {
  return client().commitGitChanges(context);
}

export async function createGitBranch(context: GitRequestContext & { payload: CreateBranchPayload }) {
  return client().createGitBranch(context);
}

export async function pushGitBranch(context: GitRequestContext & { payload: PushPayload }) {
  return client().pushGitBranch(context);
}

export async function createGitPullRequest(context: GitRequestContext & { payload: CreatePullRequestFromRunPayload }) {
  return client().createGitPullRequest(context);
}
