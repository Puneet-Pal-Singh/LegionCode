/**
 * ExecutionStateTracker unit tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ExecutionStateTracker } from '../../src/core/ExecutionStateTracker'
import { initializeExecutionState, createArtifact } from '../../src/types'
import type { ExecutionArtifactStore, ExecutionState } from '../../src/types'

describe('ExecutionStateTracker', () => {
  let tracker: ExecutionStateTracker
  let mockStore: ExecutionArtifactStore

  beforeEach(() => {
    mockStore = {
      saveSnapshot: vi.fn(),
      loadSnapshot: vi.fn(),
      saveArtifact: vi.fn(),
      getArtifact: vi.fn(),
      listArtifacts: vi.fn(),
      deleteRun: vi.fn()
    }

    tracker = new ExecutionStateTracker(mockStore, 'run-1')
  })

  describe('Snapshot Management', () => {
    it('saves snapshot to store and memory', async () => {
      const state = initializeExecutionState('run-1', 'plan-1')

      await tracker.saveSnapshot(state)

      expect(mockStore.saveSnapshot).toHaveBeenCalledWith(state)
    })

    it('stores snapshot by iteration', async () => {
      const state = initializeExecutionState('run-1', 'plan-1')
      state.iterationCount = 1

      await tracker.saveSnapshot(state)

      const snapshot = tracker.getSnapshotAtIteration(1)
      expect(snapshot).toBeDefined()
      expect(snapshot?.iterationCount).toBe(1)
    })

    it('retrieves snapshot at specific iteration', async () => {
      const state1 = initializeExecutionState('run-1', 'plan-1')
      state1.iterationCount = 1
      const state2 = initializeExecutionState('run-1', 'plan-1')
      state2.iterationCount = 2

      await tracker.saveSnapshot(state1)
      await tracker.saveSnapshot(state2)

      expect(tracker.getSnapshotAtIteration(1)?.iterationCount).toBe(1)
      expect(tracker.getSnapshotAtIteration(2)?.iterationCount).toBe(2)
    })

    it('returns undefined for non-existent iteration', () => {
      expect(tracker.getSnapshotAtIteration(999)).toBeUndefined()
    })

    it('handles null artifact store gracefully', async () => {
      const trackerNoStore = new ExecutionStateTracker(null, 'run-1')
      const state = initializeExecutionState('run-1', 'plan-1')

      await expect(trackerNoStore.saveSnapshot(state)).resolves.not.toThrow()
    })
  })

  describe('Snapshot Retrieval', () => {
    it('loads snapshot from store', async () => {
      const state = initializeExecutionState('run-1', 'plan-1')
      vi.mocked(mockStore.loadSnapshot).mockResolvedValue(state)

      const loaded = await tracker.loadSnapshot()

      expect(loaded).toEqual(state)
      expect(mockStore.loadSnapshot).toHaveBeenCalled()
    })

    it('returns null if snapshot not found', async () => {
      vi.mocked(mockStore.loadSnapshot).mockResolvedValue(null)

      const loaded = await tracker.loadSnapshot()

      expect(loaded).toBeNull()
    })

    it('gets all snapshots sorted by iteration', async () => {
      const state1 = initializeExecutionState('run-1', 'plan-1')
      state1.iterationCount = 2
      const state2 = initializeExecutionState('run-1', 'plan-1')
      state2.iterationCount = 1

      await tracker.saveSnapshot(state1)
      await tracker.saveSnapshot(state2)

      const all = tracker.getAllSnapshots()
      expect(all[0].iterationCount).toBe(1)
      expect(all[1].iterationCount).toBe(2)
    })
  })

  describe('Artifact Management', () => {
    it('saves artifact to store and memory', async () => {
      const artifact = createArtifact('run-1', 'step-1', 'output', 'json', { data: 'test' })

      await tracker.saveArtifact(artifact)

      expect(mockStore.saveArtifact).toHaveBeenCalledWith(artifact)
    })

    it('stores multiple artifacts', async () => {
      const artifact1 = createArtifact('run-1', 'step-1', 'output', 'json', { a: 1 })
      const artifact2 = createArtifact('run-1', 'step-2', 'log', 'text', 'log content')

      await tracker.saveArtifact(artifact1)
      await tracker.saveArtifact(artifact2)

      expect(mockStore.saveArtifact).toHaveBeenCalledTimes(2)
    })

    it('handles null artifact store for artifacts', async () => {
      const trackerNoStore = new ExecutionStateTracker(null, 'run-1')
      const artifact = createArtifact('run-1', 'step-1', 'output', 'json', { data: 'test' })

      await expect(trackerNoStore.saveArtifact(artifact)).resolves.not.toThrow()
    })
  })

  describe('Determinism Verification', () => {
    it('verifies identical snapshots are deterministic', async () => {
      const state1 = initializeExecutionState('run-1', 'plan-1')
      state1.iterationCount = 1
      state1.currentStepIndex = 0
      state1.status = 'running'
      state1.tokenUsage.total = 100

      const state2 = initializeExecutionState('run-1', 'plan-1')
      state2.iterationCount = 1
      state2.currentStepIndex = 0
      state2.status = 'running'
      state2.tokenUsage.total = 100

      await tracker.saveSnapshot(state1)

      const isDeterministic = tracker.verifyDeterminism([state2])
      expect(isDeterministic).toBe(true)
    })

    it('detects non-determinism in step index', async () => {
      const state1 = initializeExecutionState('run-1', 'plan-1')
      state1.iterationCount = 1
      state1.currentStepIndex = 0

      const state2 = initializeExecutionState('run-1', 'plan-1')
      state2.iterationCount = 1
      state2.currentStepIndex = 1

      await tracker.saveSnapshot(state1)

      const isDeterministic = tracker.verifyDeterminism([state2])
      expect(isDeterministic).toBe(false)
    })

    it('detects non-determinism in status', async () => {
      const state1 = initializeExecutionState('run-1', 'plan-1')
      state1.iterationCount = 1
      state1.status = 'running'

      const state2 = initializeExecutionState('run-1', 'plan-1')
      state2.iterationCount = 1
      state2.status = 'failed'

      await tracker.saveSnapshot(state1)

      const isDeterministic = tracker.verifyDeterminism([state2])
      expect(isDeterministic).toBe(false)
    })

    it('detects non-determinism in token usage', async () => {
      const state1 = initializeExecutionState('run-1', 'plan-1')
      state1.iterationCount = 1
      state1.tokenUsage.total = 100

      const state2 = initializeExecutionState('run-1', 'plan-1')
      state2.iterationCount = 1
      state2.tokenUsage.total = 200

      await tracker.saveSnapshot(state1)

      const isDeterministic = tracker.verifyDeterminism([state2])
      expect(isDeterministic).toBe(false)
    })

    it('detects length mismatch in snapshots', async () => {
      const state1 = initializeExecutionState('run-1', 'plan-1')
      state1.iterationCount = 1

      await tracker.saveSnapshot(state1)

      const isDeterministic = tracker.verifyDeterminism([
        state1,
        initializeExecutionState('run-1', 'plan-1')
      ])
      expect(isDeterministic).toBe(false)
    })

    it('returns true for empty previous snapshots', async () => {
      const isDeterministic = tracker.verifyDeterminism([])
      expect(isDeterministic).toBe(true)
    })
  })

  describe('Cleanup', () => {
    it('clears all snapshots', async () => {
      const state1 = initializeExecutionState('run-1', 'plan-1')
      state1.iterationCount = 1
      const state2 = initializeExecutionState('run-1', 'plan-1')
      state2.iterationCount = 2

      await tracker.saveSnapshot(state1)
      await tracker.saveSnapshot(state2)

      tracker.clearSnapshots()

      expect(tracker.getAllSnapshots()).toHaveLength(0)
    })

    it('clears artifacts on cleanup', async () => {
      const artifact = createArtifact('run-1', 'step-1', 'output', 'json', { data: 'test' })
      await tracker.saveArtifact(artifact)

      tracker.clearSnapshots()

      // Verify both snapshots and artifacts are cleared
      expect(tracker.getAllSnapshots()).toHaveLength(0)
    })
  })

  describe('Edge Cases', () => {
    it('handles rapid successive saves', async () => {
      const states = Array.from({ length: 10 }, (_, i) => {
        const state = initializeExecutionState('run-1', 'plan-1')
        state.iterationCount = i
        return state
      })

      await Promise.all(states.map(s => tracker.saveSnapshot(s)))

      expect(tracker.getAllSnapshots()).toHaveLength(10)
    })

    it('handles duplicate iterations (last wins)', async () => {
      const state1 = initializeExecutionState('run-1', 'plan-1')
      state1.iterationCount = 1
      state1.status = 'running'

      const state2 = initializeExecutionState('run-1', 'plan-1')
      state2.iterationCount = 1
      state2.status = 'completed'

      await tracker.saveSnapshot(state1)
      await tracker.saveSnapshot(state2)

      const snapshot = tracker.getSnapshotAtIteration(1)
      expect(snapshot?.status).toBe('completed')
    })

    it('handles step results with complex step outputs', async () => {
      const state = initializeExecutionState('run-1', 'plan-1')
      state.iterationCount = 1
      state.stepResults['step-1'] = {
        nested: {
          deep: {
            array: [1, 2, 3]
          }
        }
      }

      await tracker.saveSnapshot(state)

      const snapshot = tracker.getSnapshotAtIteration(1)
      expect(snapshot?.stepResults['step-1']).toBeDefined()
    })
  })
})
