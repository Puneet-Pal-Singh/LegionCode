export * from "./server/errors.js";
export * from "./server/InstanceEnvironment.js";
export * from "./server/ProcessSupervisor.js";
export * from "./server/ScopedRequestReply.js";
export * from "./server/ObservationDeliveryJournal.js";
export * from "./server/HarnessHost.js";
export * from "./server/HarnessDriver.js";
export * from "./server/HarnessRegistry.js";
export * from "./server/HarnessSessionManager.js";
export * from "./server/HarnessExecutionPort.js";

// Node composition consumes the canonical opening contract through this private facade.
export { fingerprintHarnessCommand, HarnessStartCommandSchema } from "@repo/worker-protocol";
