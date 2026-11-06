import type { InitializeParams } from "./protocol/generated/InitializeParams.js";
import type { InitializeResponse } from "./protocol/generated/InitializeResponse.js";
import {
  CodexStdioTransport,
  CodexTransportError,
} from "./transport/CodexStdioTransport.js";

/** Call once on a new private process connection, before any session operations. */
export async function initializeCodex(
  transport: CodexStdioTransport,
  clientVersion: string,
): Promise<InitializeResponse> {
  const params: InitializeParams = {
    clientInfo: {
      name: "legioncode",
      title: "LegionCode",
      version: clientVersion,
    },
    capabilities: { experimentalApi: false, requestAttestation: false },
  };
  const result = await transport.request("initialize", params);
  if (
    result === null ||
    typeof result !== "object" ||
    !("userAgent" in result) ||
    typeof result.userAgent !== "string" ||
    !("codexHome" in result) ||
    typeof result.codexHome !== "string" ||
    !("platformFamily" in result) ||
    typeof result.platformFamily !== "string" ||
    !("platformOs" in result) ||
    typeof result.platformOs !== "string"
  ) {
    transport.close();
    throw new CodexTransportError("invalid_frame");
  }
  transport.notify("initialized");
  return {
    userAgent: result.userAgent,
    codexHome: result.codexHome,
    platformFamily: result.platformFamily,
    platformOs: result.platformOs,
  };
}
