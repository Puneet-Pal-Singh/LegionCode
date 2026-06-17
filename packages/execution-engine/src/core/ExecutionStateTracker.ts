/**
 * Execution State Tracker
 * Persists execution snapshots and enables replay capability
 */

import type { ExecutionState, ExecutionArtifactStore, Artifact } from '../types/index.js'
import { createArtifact } from '../types/index.js'

export class ExecutionStateTracker {
  private snapshots: Map<number, ExecutionState> = new Map() // iteration -> state
  private artifacts: Artifact[] = []

  constructor(
    private artifactStore: ExecutionArtifactStore | null,
    private runId: string
  ) {}

  /**
   * Save execution state snapshot
   * Preserves step index, outputs, token usage, iteration count
   */
  async saveSnapshot(state: ExecutionState): Promise<void> {
    // Store in memory
    this.snapshots.set(state.iterationCount, { ...state })

    // Persist to artifact store if available
    if (this.artifactStore) {
      await this.artifactStore.saveSnapshot(state)
    }
  }

  /**
   * Load execution state snapshot by run ID
   */
  async loadSnapshot(): Promise<ExecutionState | null> {
    if (!this.artifactStore) {
      return null
    }
    return this.artifactStore.loadSnapshot(this.runId)
  }

  /**
   * Get snapshot at specific iteration
   */
  getSnapshotAtIteration(iteration: number): ExecutionState | undefined {
    return this.snapshots.get(iteration)
  }

  /**
   * Get all snapshots
   */
  getAllSnapshots(): ExecutionState[] {
    const sorted = Array.from(this.snapshots.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([_, state]) => state)
    return sorted
  }

  /**
   * Save execution artifact
   */
  async saveArtifact(artifact: Artifact): Promise<void> {
    this.artifacts.push(artifact)

    if (this.artifactStore) {
      await this.artifactStore.saveArtifact(artifact)
    }
  }

  /**
   * Verify determinism by comparing snapshots
   * Same inputs -> identical state transitions
   */
  verifyDeterminism(previousSnapshots: ExecutionState[]): boolean {
    if (previousSnapshots.length === 0) {
      return true // Nothing to compare
    }

    const currentSnapshots = this.getAllSnapshots()

    if (currentSnapshots.length !== previousSnapshots.length) {
      return false
    }

    for (let i = 0; i < currentSnapshots.length; i++) {
      const current = currentSnapshots[i]
      const previous = previousSnapshots[i]

      if (!current || !previous) {
        return false
      }

      // Compare critical state
      if (
        current.currentStepIndex !== previous.currentStepIndex ||
        current.status !== previous.status ||
        JSON.stringify(current.stepResults) !== JSON.stringify(previous.stepResults) ||
        current.tokenUsage.total !== previous.tokenUsage.total
      ) {
        return false
      }
    }

    return true
  }

  /**
   * Cleanup snapshots (for testing)
   */
  clearSnapshots(): void {
    this.snapshots.clear()
    this.artifacts = []
  }
}
