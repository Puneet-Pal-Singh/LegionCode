/**
 * In-Memory Artifact Store
 * Stores artifacts and snapshots in memory for testing and development
 */

import type { ExecutionArtifactStore, Artifact } from '../types/index.js'
import type { ExecutionState } from '../types/index.js'

/**
 * In-memory artifact store for testing and development
 * Useful for unit tests and scenarios where persistence is not required
 */
export class InMemoryArtifactStore implements ExecutionArtifactStore {
  private artifacts: Map<string, Artifact[]> = new Map()
  private snapshots: Map<string, ExecutionState> = new Map()

  /**
   * Save execution state snapshot
   */
  async saveSnapshot(state: ExecutionState): Promise<void> {
    // Deep clone to prevent external mutations
    this.snapshots.set(state.runId, JSON.parse(JSON.stringify(state)))
  }

  /**
   * Load execution state snapshot
   */
  async loadSnapshot(runId: string): Promise<ExecutionState | null> {
    const snapshot = this.snapshots.get(runId)
    // Return null if not found, otherwise deep clone
    return snapshot ? JSON.parse(JSON.stringify(snapshot)) : null
  }

  /**
   * Save individual artifact
   */
  async saveArtifact(artifact: Artifact): Promise<void> {
    const key = artifact.runId
    if (!this.artifacts.has(key)) {
      this.artifacts.set(key, [])
    }
    // Deep clone to prevent external mutations
    this.artifacts.get(key)!.push(JSON.parse(JSON.stringify(artifact)))
  }

  /**
   * Retrieve artifact by ID
   */
  async getArtifact(runId: string, artifactId: string): Promise<Artifact | null> {
    const artifacts = this.artifacts.get(runId)
    if (!artifacts) return null

    const artifact = artifacts.find(a => a.id === artifactId)
    // Return null if not found, otherwise deep clone
    return artifact ? JSON.parse(JSON.stringify(artifact)) : null
  }

  /**
   * List all artifacts for a run
   */
  async listArtifacts(runId: string): Promise<Artifact[]> {
    const artifacts = this.artifacts.get(runId)
    // Return empty array if not found, otherwise deep clone
    return artifacts ? JSON.parse(JSON.stringify(artifacts)) : []
  }

  /**
   * Delete all artifacts for a run
   */
  async deleteRun(runId: string): Promise<void> {
    this.artifacts.delete(runId)
    this.snapshots.delete(runId)
  }

  /**
   * Clear all stored data (useful for testing)
   */
  clear(): void {
    this.artifacts.clear()
    this.snapshots.clear()
  }

  /**
   * Get count of runs stored
   */
  getRunCount(): number {
    return new Set([...this.artifacts.keys(), ...this.snapshots.keys()]).size
  }

  /**
   * Get count of artifacts for a specific run
   */
  getArtifactCount(runId: string): number {
    return this.artifacts.get(runId)?.length ?? 0
  }
}
