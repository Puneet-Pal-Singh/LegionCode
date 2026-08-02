import {
  EditArtifactDiffResponseSchema,
  PromptArtifactReviewSourceSchema,
  type EditArtifactDiffResponse,
  type PromptArtifactReviewSource,
  type EditArtifactIdentity,
} from "@repo/shared-types";
import {
  editArtifactByMessagePath,
  editArtifactDiffPath,
  latestEditArtifactPath,
} from "./platform-endpoints.js";
import { logClientEvent, logClientWarning } from "./client-logger.js";

export async function getLatestEditArtifactReviewSource(input: {
  runId: string;
  sessionId?: string;
  identity: EditArtifactIdentity;
}): Promise<PromptArtifactReviewSource | null> {
  const response = await fetch(
    latestEditArtifactPath({ ...input, ...input.identity }),
    {
      credentials: "include",
    },
  );
  return await readNullableArtifactResponse(response);
}

export async function getEditArtifactReviewSourceByMessage(input: {
  runId: string;
  assistantMessageId: string;
  identity: EditArtifactIdentity;
}): Promise<PromptArtifactReviewSource | null> {
  const result = await getEditArtifactReviewSourceByMessageWithStatus(input);
  return result.source;
}

export async function getEditArtifactReviewSourceByMessageWithStatus(input: {
  runId: string;
  assistantMessageId: string;
  identity: EditArtifactIdentity;
}): Promise<{
  source: PromptArtifactReviewSource | null;
  status: number;
}> {
  logClientEvent("artifact/lookup", "requested", {
    runId: input.runId,
    assistantMessageId: input.assistantMessageId,
  });
  const response = await fetch(
    editArtifactByMessagePath({ ...input, ...input.identity }),
    {
      credentials: "include",
    },
  );
  const source = await readNullableArtifactResponse(response);
  logArtifactLookupResult(input, response.status, source);
  if (
    source &&
    (source.assistantMessageId !== input.assistantMessageId ||
      source.threadId !== input.identity.threadId ||
      source.turnId !== input.identity.turnId ||
      source.runAttemptId !== input.identity.runAttemptId ||
      source.workspaceId !== input.identity.workspaceId)
  ) {
    return { source: null, status: response.status };
  }
  return { source, status: response.status };
}

export async function getEditArtifactDiff(input: {
  artifactId: string;
  path: string;
  identity: EditArtifactIdentity;
}): Promise<EditArtifactDiffResponse> {
  const response = await fetch(
    editArtifactDiffPath({ ...input, ...input.identity }),
    {
      credentials: "include",
    },
  );
  if (!response.ok) {
    throw new Error(await readArtifactError(response, "Failed to fetch diff"));
  }
  return EditArtifactDiffResponseSchema.parse(await response.json());
}

async function readNullableArtifactResponse(
  response: Response,
): Promise<PromptArtifactReviewSource | null> {
  if (response.status === 204 || response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(
      await readArtifactError(response, "Failed to fetch edit artifact"),
    );
  }
  return PromptArtifactReviewSourceSchema.parse(await response.json());
}

async function readArtifactError(
  response: Response,
  fallback: string,
): Promise<string> {
  try {
    const payload = (await response.json()) as unknown;
    if (
      typeof payload === "object" &&
      payload !== null &&
      "error" in payload &&
      typeof payload.error === "string"
    ) {
      return payload.error;
    }
  } catch {
    return fallback;
  }
  return fallback;
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
