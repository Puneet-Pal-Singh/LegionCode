/**
 * Context Assembly Engine
 *
 * Vendor-neutral interfaces for converting world state → LLM context.
 *
 * @example
 * ```typescript
 * import type {
 *   ContextBuilder,
 *   ContextBuildInput,
 *   ContextBundle
 * } from '@legioncode/context-assembly'
 *
 * // Implement the interface
 * class MyContextBuilder implements ContextBuilder {
 *   async build(input: ContextBuildInput): Promise<ContextBundle> {
 *     // Implementation
 *   }
 * }
 * ```
 */

// Re-export all types
export * from "./types/index.js";
