/**
 * Artifact and artifact store type definitions
 */

import { z } from 'zod'
import type { ExecutionState } from './execution.js'

export const ArtifactTypeSchema = z.enum(['plan', 'output', 'diff', 'log', 'trace'])

export type ArtifactType = z.infer<typeof ArtifactTypeSchema>

export const ArtifactFormatSchema = z.enum(['json', 'text', 'markdown', 'binary'])

export type ArtifactFormat = z.infer<typeof ArtifactFormatSchema>

export const ArtifactSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  stepId: z.string().min(1),
  type: ArtifactTypeSchema,
  format: ArtifactFormatSchema,
  content: z.unknown(),
  size: z.number().nonnegative(),
  timestamp: z.number().int().positive(),
  metadata: z.record(z.unknown()).optional()
})

export type Artifact = z.infer<typeof ArtifactSchema>

/**
 * Abstract artifact store interface
 */
export interface ExecutionArtifactStore {
  /**
   * Save execution state snapshot
   */
  saveSnapshot(state: ExecutionState): Promise<void>

  /**
   * Load execution state snapshot
   */
  loadSnapshot(runId: string): Promise<ExecutionState | null>

  /**
   * Save individual artifact
   */
  saveArtifact(artifact: Artifact): Promise<void>

  /**
   * Retrieve artifact by ID
   */
  getArtifact(runId: string, artifactId: string): Promise<Artifact | null>

  /**
   * List all artifacts for a run
   */
  listArtifacts(runId: string): Promise<Artifact[]>

  /**
   * Delete all artifacts for a run
   */
  deleteRun(runId: string): Promise<void>
}

/**
 * Create an artifact from execution data
 */
export function createArtifact(
  runId: string,
  stepId: string,
  type: ArtifactType,
  format: ArtifactFormat,
  content: unknown,
  metadata?: Record<string, unknown>
): Artifact {
  const contentStr = format === 'binary' ? JSON.stringify(content) : String(content)
  const size = Buffer.byteLength(contentStr, 'utf-8')

  return {
    id: `${runId}-${stepId}-${type}-${Date.now()}`,
    runId,
    stepId,
    type,
    format,
    content,
    size,
    timestamp: Date.now(),
    metadata
  }
}
