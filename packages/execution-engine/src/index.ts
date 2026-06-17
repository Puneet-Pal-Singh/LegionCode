/**
 * @shadowbox/execution-engine
 * Deterministic execution engine for orchestrating agent tasks
 */

// Types
export * from './types/index.js'

// Core components
export * from './core/index.js'

// Adapters (model providers)
export { OpenAIAdapter, LocalMockAdapter } from './adapters/index.js'
export type { OpenAIAdapterConfig, LocalMockAdapterConfig } from './adapters/index.js'
export {
  ToolDefinitionSchema,
  ModelInputSchema,
  ModelOutputSchema,
  ModelToolCallSchema,
  buildSystemPrompt,
  buildUserMessage,
  ProviderAdapterRegistry,
  InvalidProviderAdapterIdError,
  DuplicateProviderAdapterRegistrationError,
  ProviderAdapterNotRegisteredError,
  ProviderAdapterIdSchema
} from './adapters/index.js'
export type {
  ToolDefinition,
  ModelInput,
  ModelOutput,
  ModelToolCall,
  ModelProvider,
  ProviderAdapterId,
  ProviderAdapterFactory,
  ProviderAdapterRegistration,
  ProviderAdapterDescriptor
} from './adapters/index.js'

// Output validation
export * from './output/index.js'

// Tools
export { Tool, ToolRegistry, ToolExecutor } from './tools/index.js'
export type { ToolDefinition as ToolDef, ToolExecutorConfig } from './tools/index.js'
export {
  validateFilePath,
  validateCommand,
  validateArguments,
  validateStringArg,
  validateNumberArg
} from './tools/index.js'

// Events
export { EventBus } from './events/index.js'
export type {
  ExecutionEvent,
  ExecutionStartedEvent,
  StepStartedEvent,
  ToolCalledEvent,
  ToolCompletedEvent,
  StepCompletedEvent,
  ExecutionCompletedEvent,
  ExecutionStoppedEvent,
  ExecutionFailedEvent,
  EventHandler
} from './events/index.js'

// Observability
export { ExecutionLogger, ExecutionTracer } from './observability/index.js'
export type { ExecutionSpan, ExecutionTimeline } from './observability/index.js'

// Artifacts
export { InMemoryArtifactStore, FileArtifactStore } from './artifacts/index.js'
export type { FileArtifactStoreConfig } from './artifacts/index.js'
export type { ExecutionArtifactStore } from './types/index.js'

// Pricing
// Phase 2.5: Abstraction (PricingProvider interface)
// Phase 3: Real implementations (LiteLLMPricingProvider, OpenAIPricingProvider, etc.)
// Pricing must come from LLM API providers only, NOT hardcoded files
export type { PricingProvider, ModelPricingData } from './pricing/index.js'
export { MockPricingProvider } from './pricing/index.js'

// Cost tracking
export { CostTracker, CostCalculator } from './cost/index.js'
export type { Cost, CostSummary } from './cost/index.js'

/**
 * @deprecated Import runtime symbols from `@shadowbox/execution-engine/runtime` instead.
 */
export * as Runtime from './runtime/index.js'
