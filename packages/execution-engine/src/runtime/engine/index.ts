// packages/execution-engine/src/runtime/engine/index.ts
// Phase 3.2: Engine module barrel exports

export {
  RunEngineError,
  type RunEngineDependencies,
  type RunEngineEnv,
  type RunEngineOptions,
} from "./RunEngine.js";
export {
  PermissionApprovalStore,
  type PermissionDecisionResult,
} from "./PermissionApprovalStore.js";

export { DefaultTaskExecutor, AgentTaskExecutor } from "./TaskExecutor.js";
export {
  RuntimeKernelNativeRunner,
  type RuntimeKernelNativeRunnerInput,
} from "./RuntimeKernelNativeRunner.js";
export {
  getCodingCoreToolRegistry,
  getCodingToolRoute,
  isCodingToolId,
  enforceCodingToolFloor,
  type CodingToolId,
  type ToolGatewayRoute,
} from "../tools/CodingToolRegistry.js";
