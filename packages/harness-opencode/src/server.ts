// Explicit Node-only entry. Public/browser capability contracts remain in platform-protocol.
export { OpenCodeClient, OpenCodeTransportError } from "./OpenCodeClient.js";
export { OpenCodeSession } from "./OpenCodeSession.js";
export {
  createOpenCodeServerPassword,
  openCodeServerEnvironment,
} from "./OpenCodeAuthentication.js";
export {
  OPENCODE_VERSION,
  OPENCODE_TRANSPORT,
  OPENCODE_SOURCE_REVISION,
  OPENCODE_SERVER_ARGUMENTS,
  requireOpenCodeVersion,
  verifyOpenCodeProbe,
  readOpenCodeServerUrl,
} from "./OpenCodeInstallation.js";
