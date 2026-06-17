/**
 * File-Based Artifact Store
 * Persists artifacts and snapshots to the filesystem
 */

import { promises as fs } from 'fs'
import { join, dirname } from 'path'
import type { ExecutionArtifactStore, Artifact } from '../types/index.js'
import type { ExecutionState } from '../types/index.js'

/**
 * Configuration for file artifact store
 */
export interface FileArtifactStoreConfig {
  /**
   * Base directory for storing artifacts
   */
  basePath: string

  /**
   * Create directory structure if it doesn't exist
   */
  autoCreate?: boolean
}

/**
 * File-based artifact store for persistent local storage
 * Organizes artifacts by run ID in a predictable directory structure
 */
export class FileArtifactStore implements ExecutionArtifactStore {
  private basePath: string
  private autoCreate: boolean

  constructor(config: FileArtifactStoreConfig) {
    this.basePath = config.basePath
    this.autoCreate = config.autoCreate ?? true
  }

  /**
   * Get path to run directory
   */
  private getRunDir(runId: string): string {
    return join(this.basePath, 'runs', runId)
  }

  /**
   * Get path to snapshot file
   */
  private getSnapshotPath(runId: string): string {
    return join(this.getRunDir(runId), 'snapshot.json')
  }

  /**
   * Get path to artifacts directory
   */
  private getArtifactsDir(runId: string): string {
    return join(this.getRunDir(runId), 'artifacts')
  }

  /**
   * Get path to artifact file
   */
  private getArtifactPath(runId: string, artifactId: string): string {
    return join(this.getArtifactsDir(runId), `${artifactId}.json`)
  }

  /**
   * Ensure directory exists
   */
  private async ensureDir(dirPath: string): Promise<void> {
    if (!this.autoCreate) return

    try {
      await fs.mkdir(dirPath, { recursive: true })
    } catch (error) {
      // EEXIST is not an error for our purposes
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
    }
  }

  /**
   * Save execution state snapshot
   */
  async saveSnapshot(state: ExecutionState): Promise<void> {
    const runDir = this.getRunDir(state.runId)
    await this.ensureDir(runDir)

    const snapshotPath = this.getSnapshotPath(state.runId)
    const content = JSON.stringify(state, null, 2)

    await fs.writeFile(snapshotPath, content, 'utf-8')
  }

  /**
   * Load execution state snapshot
   */
  async loadSnapshot(runId: string): Promise<ExecutionState | null> {
    const snapshotPath = this.getSnapshotPath(runId)

    try {
      const content = await fs.readFile(snapshotPath, 'utf-8')
      return JSON.parse(content) as ExecutionState
    } catch (error) {
      // ENOENT means file doesn't exist, which is fine
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      throw error
    }
  }

  /**
   * Save individual artifact
   */
  async saveArtifact(artifact: Artifact): Promise<void> {
    const artifactsDir = this.getArtifactsDir(artifact.runId)
    await this.ensureDir(artifactsDir)

    const artifactPath = this.getArtifactPath(artifact.runId, artifact.id)
    const content = JSON.stringify(artifact, null, 2)

    await fs.writeFile(artifactPath, content, 'utf-8')
  }

  /**
   * Retrieve artifact by ID
   */
  async getArtifact(runId: string, artifactId: string): Promise<Artifact | null> {
    const artifactPath = this.getArtifactPath(runId, artifactId)

    try {
      const content = await fs.readFile(artifactPath, 'utf-8')
      return JSON.parse(content) as Artifact
    } catch (error) {
      // ENOENT means file doesn't exist, which is fine
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      throw error
    }
  }

  /**
   * List all artifacts for a run
   */
  async listArtifacts(runId: string): Promise<Artifact[]> {
    const artifactsDir = this.getArtifactsDir(runId)

    try {
      const files = await fs.readdir(artifactsDir, { withFileTypes: true })
      const jsonFiles = files.filter(f => f.isFile() && f.name.endsWith('.json'))

      const artifacts: Artifact[] = []
      for (const file of jsonFiles) {
        const content = await fs.readFile(join(artifactsDir, file.name), 'utf-8')
        artifacts.push(JSON.parse(content) as Artifact)
      }
      return artifacts
    } catch (error) {
      // ENOENT means directory doesn't exist yet
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw error
    }
  }

  /**
   * Delete all artifacts for a run
   */
  async deleteRun(runId: string): Promise<void> {
    const runDir = this.getRunDir(runId)

    try {
      await fs.rm(runDir, { recursive: true, force: true })
    } catch (error) {
      // If directory doesn't exist, that's fine
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
  }

  /**
   * Get the base path
   */
  getBasePath(): string {
    return this.basePath
  }
}
