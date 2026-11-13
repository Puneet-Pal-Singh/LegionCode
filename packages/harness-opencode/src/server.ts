// Explicit Node-only entry. Public/browser capability contracts remain in platform-protocol.
export { OpenCodeClient, OpenCodeTransportError } from "./server/OpenCodeClient.js";
export { OpenCodeSession } from "./server/OpenCodeSession.js";
export {
  createOpenCodeServerPassword,
  openCodeServerEnvironment,
} from "./server/OpenCodeAuthentication.js";
export {
  OPENCODE_VERSION,
  OPENCODE_TRANSPORT,
  OPENCODE_SOURCE_REVISION,
  OPENCODE_SERVER_ARGUMENTS,
  requireOpenCodeVersion,
  verifyOpenCodeProbe,
  readOpenCodeServerUrl,
} from "./server/OpenCodeInstallation.js";

export { OpenCodeV2Driver } from "./server/OpenCodeV2Driver.js";
export { OpenCodeServerOwner } from "./server/OpenCodeServerOwner.js";
