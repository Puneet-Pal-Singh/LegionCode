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

  const capabilities: AppServerInitializeResponse["capabilities"] =
    options.environment === "local"
      ? [
          ...LOCAL_APP_SERVER_CAPABILITIES,
          ...(options.localWorkspaceFilesAvailable ? ["workspace-files-v1" as const] : []),
          ...(options.localTurnExecutionAvailable ? ["turn-execution-v1" as const] : []),
          ...(options.localSavedReviewAvailable ? ["artifact-review-v1" as const] : []),
          ...(options.localSavedCommitAvailable ? ["artifact-commit-v1" as const] : []),
        ]
      : [];
  const availableCapabilities = new Set<string>(capabilities);

  return {
    statusCode: 200,
    payload: {
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      server: { id: options.serverId, version: options.serverVersion },
      environment: options.environment,
      ...(options.environment === "local" && options.localTurnConfiguration
        ? { localTurnConfiguration: options.localTurnConfiguration }
        : {}),
      capabilities,
      unavailableCapabilities:
        options.environment === "local"
          ? LOCAL_APP_SERVER_UNAVAILABLE_CAPABILITIES.filter((capability) =>
              !availableCapabilities.has(capability),
            ).map((capability) => ({
              capability,
              reason: capability === "artifact-commit-v1" ? "Saved commits are unavailable." : "This local capability is planned for a later slice",
            }))
          : [],
    },
  };
}
