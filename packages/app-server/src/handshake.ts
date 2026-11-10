import {
  APP_SERVER_PROTOCOL_VERSION,
  AppServerInitializeRequestSchema,
  LOCAL_APP_SERVER_CAPABILITIES,
  LOCAL_APP_SERVER_UNAVAILABLE_CAPABILITIES,
  type AppServerInitializeResponse,
  type LocalTurnConfigurationOptions,
} from "@repo/platform-protocol";

export type AppServerHandshakeEnvironment = "local" | "hosted";

export type AppServerInitializeResult =
  | { statusCode: 200; payload: AppServerInitializeResponse }
  | {
      statusCode: 400 | 409;
      payload: { code: "invalid_request" | "protocol_incompatible"; message: string };
    };

export function initializeAppServer(
  body: unknown,
  options: {
    environment: AppServerHandshakeEnvironment;
    serverId: string;
    serverVersion: string;
    localWorkspaceFilesAvailable?: boolean;
    localWorkspaceGitReadsAvailable?: boolean;
    localTurnExecutionAvailable?: boolean;
    localTurnConfiguration?: LocalTurnConfigurationOptions;
    localSavedReviewAvailable?: boolean;
    localSavedCommitAvailable?: boolean;
  },
): AppServerInitializeResult {
  const parsed = AppServerInitializeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return {
      statusCode: 400,
      payload: {
        code: "invalid_request",
        message: "App Server initialize request is invalid",
      },
    };
  }
  if (parsed.data.protocolVersion !== APP_SERVER_PROTOCOL_VERSION) {
    return {
      statusCode: 409,
      payload: {
        code: "protocol_incompatible",
        message: "App Server protocol version is incompatible",
      },
    };
  }

  return {
    statusCode: 200,
    payload: {
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      server: { id: options.serverId, version: options.serverVersion },
      environment: options.environment,
      ...(options.environment === "local" && options.localTurnConfiguration
        ? { localTurnConfiguration: options.localTurnConfiguration }
        : {}),
      capabilities:
        options.environment === "local"
          ? [
              ...LOCAL_APP_SERVER_CAPABILITIES,
              ...(options.localWorkspaceFilesAvailable ? ["workspace-files-v1"] : []),
              ...(options.localWorkspaceGitReadsAvailable ? ["workspace-git-reads-v1"] : []),
              ...(options.localTurnExecutionAvailable ? ["turn-execution-v1"] : []),
              ...(options.localSavedReviewAvailable ? ["artifact-review-v1"] : []),
              ...(options.localSavedCommitAvailable ? ["artifact-commit-v1"] : []),
            ]
          : [],
      unavailableCapabilities:
        options.environment === "local"
          ? LOCAL_APP_SERVER_UNAVAILABLE_CAPABILITIES.filter((capability) =>
              (capability !== "turn-execution-v1" || !options.localTurnExecutionAvailable) &&
              (capability !== "artifact-review-v1" || !options.localSavedReviewAvailable),
            ).map((capability) => ({
              capability,
              reason: "This local capability is planned for a later slice",
            }))
          : [],
    },
  };
}
