import {
  EditArtifactDiffResponseSchema,
  PromptArtifactReviewSourceSchema,
  type EditArtifactDiffResponse,
  type PromptArtifactReviewSource,
} from "@repo/shared-types";
import {
  editArtifactByMessagePath,
  editArtifactDiffPath,
  latestEditArtifactPath,
} from "./platform-endpoints.js";

export async function getLatestEditArtifactReviewSource(input: {
  runId: string;
  sessionId?: string;
}): Promise<PromptArtifactReviewSource | null> {
  const response = await fetch(latestEditArtifactPath(input), {
    credentials: "include",
  });
  return await readNullableArtifactResponse(response);
}

export async function getEditArtifactReviewSourceByMessage(input: {
  runId: string;
  assistantMessageId: string;
}): Promise<PromptArtifactReviewSource | null> {
  const response = await fetch(editArtifactByMessagePath(input), {
    credentials: "include",
  });
  return await readNullableArtifactResponse(response);
}

export async function getEditArtifactDiff(input: {
  artifactId: string;
  path: string;
}): Promise<EditArtifactDiffResponse> {
  const response = await fetch(editArtifactDiffPath(input), {
    credentials: "include",
  });
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
