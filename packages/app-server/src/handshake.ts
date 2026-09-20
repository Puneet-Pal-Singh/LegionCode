import {
  APP_SERVER_PROTOCOL_VERSION,
  AppServerInitializeRequestSchema,
  LOCAL_APP_SERVER_CAPABILITIES,
  LOCAL_APP_SERVER_UNAVAILABLE_CAPABILITIES,
  type AppServerInitializeResponse,
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
      capabilities:
        options.environment === "local"
          ? [...LOCAL_APP_SERVER_CAPABILITIES]
          : [],
      unavailableCapabilities:
        options.environment === "local"
          ? LOCAL_APP_SERVER_UNAVAILABLE_CAPABILITIES.map((capability) => ({
              capability,
              reason: "This local capability is planned for a later slice",
            }))
          : [],
    },
  };
}
