import type {
  EditArtifactDiffResponse,
  EditArtifactIdentity,
  PromptArtifactReviewSource,
} from "@repo/shared-types";
import {
  AppServerClientError,
  AppServerTransportError,
  type ArtifactReviewLookupResult,
} from "@legioncode/sdk";
import { createHostedAppServerClient } from "./appServerClient.js";
import { logClientEvent, logClientWarning } from "../../lib/client-logger.js";

export async function getLatestEditArtifactReviewSource(input: {
  runId: string;
  sessionId?: string;
  identity: EditArtifactIdentity;
}): Promise<PromptArtifactReviewSource | null> {
  const result = await readNullableLookup(() =>
    createHostedAppServerClient({ timeoutMs: null, maxResponseBytes: null })
      .getLatestEditArtifactReviewSource(input),
  );
  return result.source;
}

export async function getEditArtifactReviewSourceByMessage(input: {
  runId: string;
  assistantMessageId: string;
  identity: EditArtifactIdentity;
}): Promise<PromptArtifactReviewSource | null> {
  return (await getEditArtifactReviewSourceByMessageWithStatus(input)).source;
}

export async function getEditArtifactReviewSourceByMessageWithStatus(input: {
  runId: string;
  assistantMessageId: string;
  identity: EditArtifactIdentity;
}): Promise<ArtifactReviewLookupResult | { source: null; status: 404 }> {
  logClientEvent("artifact/lookup", "requested", {
    runId: input.runId,
    assistantMessageId: input.assistantMessageId,
  });
  let result: ArtifactReviewLookupResult | { source: null; status: 404 };
  try {
    result = await createHostedAppServerClient({ timeoutMs: null, maxResponseBytes: null })
      .getEditArtifactReviewSourceByMessage(input);
  } catch (error) {
    if (getAppServerStatus(error) !== 404) throw error;
    result = { source: null, status: 404 };
  }
  const source = result.source;
  logArtifactLookupResult(input, result.status, source);
  if (
    source &&
    (source.assistantMessageId !== input.assistantMessageId ||
      source.threadId !== input.identity.threadId ||
      source.turnId !== input.identity.turnId ||
      source.runAttemptId !== input.identity.runAttemptId ||
      source.workspaceId !== input.identity.workspaceId)
  ) {
    result = { source: null, status: result.status };
  }
  return result;
}

export async function getEditArtifactDiff(input: {
  artifactId: string;
  path: string;
  identity: EditArtifactIdentity;
}): Promise<EditArtifactDiffResponse> {
  return createHostedAppServerClient({ timeoutMs: null, maxResponseBytes: null })
    .getEditArtifactDiff(input);
}

async function readNullableLookup(
  read: () => Promise<ArtifactReviewLookupResult>,
): Promise<ArtifactReviewLookupResult | { source: null; status: 404 }> {
  try {
    return await read();
  } catch (error) {
    if (getAppServerStatus(error) === 404) return { source: null, status: 404 };
    throw error;
  }
}

function getAppServerStatus(error: unknown): number | undefined {
  if (!(error instanceof AppServerClientError)) return undefined;
  if (error.serverError?.statusCode === 404) return 404;
  return error.cause instanceof AppServerTransportError &&
    error.cause.statusCode === 404
    ? 404
    : undefined;
}

function logArtifactLookupResult(
  input: {
    runId: string;
    assistantMessageId: string;
    identity: EditArtifactIdentity;
  },
  status: number,
  source: PromptArtifactReviewSource | null,
): void {
  const context = {
    runId: input.runId,
    requestedMessageId: input.assistantMessageId,
    returnedMessageId: source?.assistantMessageId ?? null,
    artifactId: source?.artifactId ?? null,
    fileCount: source?.files.length ?? 0,
    status,
  };
  if (
    source?.assistantMessageId &&
    source.assistantMessageId !== input.assistantMessageId
  ) {
    logClientWarning("artifact/lookup", "ownership-mismatch", context);
    return;
  }
  logClientEvent("artifact/lookup", source ? "found" : "missing", context);
}
