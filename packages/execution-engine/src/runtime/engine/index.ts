// packages/execution-engine/src/runtime/engine/index.ts
// Phase 3.2: Engine module barrel exports

export {
  RunEngine,
  RunEngineError,
  type IRunEngine,
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
  executeRunEngineThroughRuntimeKernel,
  type RunEngineKernelAdapterInput,
} from "./RunEngineKernelAdapter.js";
export {
  getCodingCoreToolRegistry,
  getCodingToolRoute,
  isCodingToolId,
  enforceCodingToolFloor,
  type CodingToolId,
  type ToolGatewayRoute,
} from "../tools/CodingToolRegistry.js";
