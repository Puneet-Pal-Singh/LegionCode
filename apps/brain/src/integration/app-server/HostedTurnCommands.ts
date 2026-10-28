import {
  AppServerOperationError,
  type AppServerComposition,
} from "@legioncode/app-server/server";
import type { AppServerRequest } from "@legioncode/app-server/protocol";
import {
  InterruptTurnResponseSchema,
  type InterruptTurnResponse,
} from "@repo/platform-protocol";
import { fetchRunRuntimeRoute } from "../../controllers/chat-runtime-helpers";
import { isSessionStoreUnavailableError } from "../../services/AuthService";
import { withRunRepository } from "../../services/runs/RunPersistenceFactory";
import type { Env } from "../../types/ai";

type HostedTurnCommandsService = NonNullable<
  AppServerComposition["hostedTurnCommandsService"]
>;
type InterruptParams = Extract<
  AppServerRequest,
  { method: "turn/interrupt" }
>["params"];

/** Existing hosted turn commands composed with the App Server's verified principal. */
export function composeHostedTurnCommands(
  env: Env,
  userId: string,
): HostedTurnCommandsService {
  return {
    interruptTurn: (params) => interruptTurn(env, userId, params),
  };
}

async function interruptTurn(
  env: Env,
  userId: string,
  params: InterruptParams,
): Promise<InterruptTurnResponse> {
  try {
    const run = await withRunRepository(env, (repository) =>
      repository.getRun(params.runId, userId),
    );
    if (
      !run ||
      run.sessionId !== params.sessionId ||
      run.workspaceId !== params.workspaceId
    ) {
      throw notFound("Run not found");
    }

    const { orchestratorBackend, ...runtimePayload } = params;
    const response = await fetchRunRuntimeRoute(
      env,
      params.runId,
      orchestratorBackend ?? "execution-engine-v1",
      {
        method: "POST",
        path: "/interrupt",
        body: JSON.stringify(runtimePayload),
        headers: { "Content-Type": "application/json" },
      },
    );
    if (!response.ok) {
      const details = await readRuntimeErrorPreview(response);
      const suffix = details ? `: ${details}` : "";
      throw new AppServerOperationError(
        response.status,
        statusCategory(response.status),
        `Failed to interrupt run${suffix}`,
        "API_ERROR",
        isRetryableStatus(response.status),
      );
    }

    const responsePayload: unknown = await response.json();
    const parsed = InterruptTurnResponseSchema.safeParse(responsePayload);
    if (!parsed.success) {
      throw new AppServerOperationError(
        502,
        "server_unavailable",
        "Invalid interrupt response",
        "INVALID_RESPONSE_CONTRACT",
        false,
      );
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof AppServerOperationError) throw error;
    if (isSessionStoreUnavailableError(error)) {
      throw new AppServerOperationError(
        503,
        "server_unavailable",
        error.message,
        "API_ERROR",
        true,
      );
    }
    throw new AppServerOperationError(
      500,
      "server_unavailable",
      error instanceof Error ? error.message : "Failed to interrupt run",
      "API_ERROR",
      true,
    );
  }
}

async function readRuntimeErrorPreview(response: Response): Promise<string> {
  try {
    const payload = (await response.clone().json()) as { error?: unknown };
    if (typeof payload.error === "string" && payload.error.trim().length > 0) {
      return payload.error.trim().slice(0, 200);
    }
  } catch {
    // Fall back to a bounded plain-text preview.
  }

  try {
    const text = (await response.text()).trim();
    return text.slice(0, 200);
  } catch {
    return "";
  }
}

function statusCategory(
  status: number,
): ConstructorParameters<typeof AppServerOperationError>[1] {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status >= 500 || status === 408 || status === 429) {
    return "server_unavailable";
  }
  return "invalid_request";
}

function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

function notFound(message: string): AppServerOperationError {
  return new AppServerOperationError(404, "not_found", message, "API_ERROR", false);
}
