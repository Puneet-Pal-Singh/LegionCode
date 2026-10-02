/**
 * DockerExecutor Tests
 * Validates Docker container lifecycle and command execution
 * All tests mocked — no real Docker calls
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DockerExecutor } from '../src/executor/DockerExecutor/DockerExecutor.js'
import type { EnvironmentConfig, ExecutionTask } from '../src/types/executor.js'

/**
 * Mock execSync to avoid real Docker calls
 */
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  spawn: vi.fn()
}))

import { execSync } from 'child_process'

describe('DockerExecutor', () => {
  let executor: DockerExecutor
  let mockExecSync: ReturnType<typeof vi.fn>

  beforeEach(() => {
    executor = new DockerExecutor({
      image: 'node:18-alpine',
      baseContainerName: 'test-legioncode'
    })

    mockExecSync = execSync as ReturnType<typeof vi.fn>
    mockExecSync.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('Interface', () => {
    it('has correct name', () => {
      expect(executor.name).toBe('Docker')
    })

    it('implements Executor interface', () => {
      expect(executor.createEnvironment).toBeDefined()
      expect(executor.executeTask).toBeDefined()
      expect(executor.streamLogs).toBeDefined()
      expect(executor.destroyEnvironment).toBeDefined()
    })
  })

  describe('createEnvironment()', () => {
    beforeEach(() => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('docker --version')) return 'Docker version 20.0.0'
        if (cmd.includes('docker pull')) return undefined
        if (cmd.includes('docker run')) return 'abc123container\n'
        if (cmd.includes('docker exec')) return 'npm test output\n'
        if (cmd.includes('docker stop')) return undefined
        if (cmd.includes('docker rm')) return undefined
        throw new Error(`Unexpected mock call: ${cmd}`)
      })
    })

    it('creates Docker environment', async () => {
      const config: EnvironmentConfig = {
        runId: 'test-run-123',
        taskId: 'task-456',
        repoPath: '/home/user/repo'
      }

      const env = await executor.createEnvironment(config)

      expect(env).toBeDefined()
      expect(env.type).toBe('docker')
      expect(env.createdAt).toBeGreaterThan(0)
    })

    it('generates valid container name', async () => {
      const config: EnvironmentConfig = {
        runId: 'my-run-id-123',
        taskId: 'task',
        repoPath: '/repo'
      }

      const env = await executor.createEnvironment(config)

      expect(env.metadata?.containerName).toContain('test-legioncode')
      expect(env.metadata?.containerName).toContain('my-run-id')
    })

    it('sanitizes container name', async () => {
      const config: EnvironmentConfig = {
        runId: 'run@#$%id',
        taskId: 'task',
        repoPath: '/repo'
      }

      const env = await executor.createEnvironment(config)

      // Special chars should be removed
      expect(env.metadata?.containerName).not.toContain('@')
      expect(env.metadata?.containerName).not.toContain('#')
    })

    it('validates Docker is available', async () => {
      mockExecSync.mockImplementationOnce(() => {
        throw new Error('docker: command not found')
      })

      const config: EnvironmentConfig = {
        runId: 'test-run',
        taskId: 'task',
        repoPath: '/repo'
      }

      await expect(executor.createEnvironment(config)).rejects.toThrow('Docker is not available')
    })

    it('includes image in metadata', async () => {
      const config: EnvironmentConfig = {
        runId: 'test-run',
        taskId: 'task',
        repoPath: '/repo'
      }

      const env = await executor.createEnvironment(config)

      expect(env.metadata?.image).toBe('node:18-alpine')
    })
  })

  describe('executeTask()', () => {
    let envConfig: EnvironmentConfig

    beforeEach(() => {
      envConfig = {
        runId: 'test-run-123',
        taskId: 'task-456',
        repoPath: '/home/user/repo'
      }

      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('docker --version')) return 'Docker version 20.0.0'
        if (cmd.includes('docker pull')) return undefined
        if (cmd.includes('docker run')) return 'abc123container\n'
        if (cmd.includes('docker exec')) return 'npm test output\n'
        if (cmd.includes('docker stop')) return undefined
        if (cmd.includes('docker rm')) return undefined
        throw new Error(`Unexpected mock call: ${cmd}`)
      })
    })

    it('executes task in container', async () => {
      const env = await executor.createEnvironment(envConfig)

      const task: ExecutionTask = {
        id: 'task-1',
        command: 'npm test',
        cwd: '/home/user/repo'
      }

      const result = await executor.executeTask(env, task)

      expect(result.status).toBe('success')
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('npm test')
    })

    it('includes duration in result', async () => {
      const env = await executor.createEnvironment(envConfig)

      const task: ExecutionTask = {
        id: 'task-1',
        command: 'echo hello',
        cwd: '/repo'
      }

      const result = await executor.executeTask(env, task)

      expect(result.duration).toBeGreaterThanOrEqual(0)
    })

    it('includes timestamp', async () => {
      const env = await executor.createEnvironment(envConfig)

      const task: ExecutionTask = {
        id: 'task-1',
        command: 'echo hello',
        cwd: '/repo'
      }

      const before = Date.now()
      const result = await executor.executeTask(env, task)
      const after = Date.now()

      expect(result.timestamp).toBeGreaterThanOrEqual(before)
      expect(result.timestamp).toBeLessThanOrEqual(after)
    })

    it('rejects command chaining', async () => {
      const env = await executor.createEnvironment(envConfig)

      const task: ExecutionTask = {
        id: 'task-1',
        command: 'echo hello; rm -rf /',
        cwd: '/repo'
      }

      const result = await executor.executeTask(env, task)

      expect(result.status).toBe('error')
      expect(result.stderr).toContain('unsafe characters')
    })

    it('rejects path traversal in cwd', async () => {
      const env = await executor.createEnvironment(envConfig)

      const task: ExecutionTask = {
        id: 'task-1',
        command: 'echo hello',
        cwd: '/repo/../../../etc'
      }

      const result = await executor.executeTask(env, task)

      expect(result.status).toBe('error')
      expect(result.stderr).toContain('Path traversal')
    })

  })

  describe('streamLogs()', () => {
    let envConfig: EnvironmentConfig

    beforeEach(() => {
      envConfig = {
        runId: 'test-run',
        taskId: 'task',
        repoPath: '/repo'
      }

      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('docker --version')) return 'Docker version 20.0.0'
        if (cmd.includes('docker pull')) return undefined
        if (cmd.includes('docker run')) return 'abc123\n'
        if (cmd.includes('docker stop')) return undefined
        if (cmd.includes('docker rm')) return undefined
        throw new Error(`Unexpected mock call: ${cmd}`)
      })
    })

    it('returns async iterable', async () => {
      const env = await executor.createEnvironment(envConfig)

      const logs = await executor.streamLogs(env)

      expect(logs[Symbol.asyncIterator]).toBeDefined()
    })

    it('yields log entries', async () => {
      const env = await executor.createEnvironment(envConfig)

      const logs = await executor.streamLogs(env)
      const logArray = []

      for await (const log of logs) {
        logArray.push(log)
      }

      expect(logArray.length).toBeGreaterThan(0)
      expect(logArray[0]).toHaveProperty('timestamp')
      expect(logArray[0]).toHaveProperty('level')
      expect(logArray[0]).toHaveProperty('message')
    })
  })

  describe('destroyEnvironment()', () => {
    let envConfig: EnvironmentConfig

    beforeEach(() => {
      envConfig = {
        runId: 'test-run',
        taskId: 'task',
        repoPath: '/repo'
      }

      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('docker --version')) return 'Docker version 20.0.0'
        if (cmd.includes('docker pull')) return undefined
        if (cmd.includes('docker run')) return 'abc123\n'
        if (cmd.includes('docker stop')) return undefined
        if (cmd.includes('docker rm')) return undefined
        throw new Error(`Unexpected mock call: ${cmd}`)
      })
    })

    it('destroys Docker container', async () => {
      const env = await executor.createEnvironment(envConfig)

      await executor.destroyEnvironment(env)

      // Should call docker stop and docker rm
      const calls = mockExecSync.mock.calls
      const stopCall = calls.find(c => c[0]?.includes('docker stop'))
      const rmCall = calls.find(c => c[0]?.includes('docker rm'))

      expect(stopCall).toBeDefined()
      expect(rmCall).toBeDefined()
    })

    it('handles missing container gracefully', async () => {
      const env = {
        id: 'missing',
        type: 'docker' as const,
        createdAt: Date.now(),
        metadata: {}
      }

      // Should not throw
      await expect(executor.destroyEnvironment(env)).resolves.toBeUndefined()
    })

    it('logs on cleanup failure', async () => {
      // Create environment with normal mocks
      const env = await executor.createEnvironment(envConfig)

      // Now set up mocks to fail on docker stop
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('docker stop')) {
          throw new Error('Container not found')
        }
        if (cmd.includes('docker rm')) return undefined
        throw new Error(`Unexpected mock call: ${cmd}`)
      })

      const consoleWarnSpy = vi.spyOn(console, 'warn')

      await executor.destroyEnvironment(env)

      expect(consoleWarnSpy).toHaveBeenCalled()

      consoleWarnSpy.mockRestore()
    })
  })

  describe('Lifecycle', () => {
    beforeEach(() => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('docker --version')) return 'Docker version 20.0.0'
        if (cmd.includes('docker pull')) return undefined
        if (cmd.includes('docker run')) return 'abc123\n'
        if (cmd.includes('docker exec')) return 'task output\n'
        if (cmd.includes('docker stop')) return undefined
        if (cmd.includes('docker rm')) return undefined
        throw new Error(`Unexpected mock call: ${cmd}`)
      })
    })

    it('full lifecycle works end-to-end', async () => {
      const config: EnvironmentConfig = {
        runId: 'test-run',
        taskId: 'task',
        repoPath: '/repo'
      }

      // Create
      const env = await executor.createEnvironment(config)
      expect(env).toBeDefined()

      // Execute
      const task: ExecutionTask = {
        id: 'task-1',
        command: 'npm test',
        cwd: '/repo'
      }
      const result = await executor.executeTask(env, task)
      expect(result.status).toBe('success')

      // Stream logs
      const logs = await executor.streamLogs(env)
      const logArray = []
      for await (const log of logs) {
        logArray.push(log)
      }
      expect(logArray.length).toBeGreaterThan(0)

      // Destroy
      await executor.destroyEnvironment(env)
    })
  })

  describe('Configuration', () => {
    it('allows custom base container name', () => {
      const custom = new DockerExecutor({
        image: 'ubuntu:latest',
        baseContainerName: 'my-exec'
      })

      expect(custom).toBeDefined()
    })

    it('uses default base container name', () => {
      const defaults = new DockerExecutor({
        image: 'alpine:latest'
      })

      expect(defaults).toBeDefined()
    })

    it('allows custom network mode', () => {
      const custom = new DockerExecutor({
        image: 'ubuntu:latest',
        network: 'host'
      })

      expect(custom).toBeDefined()
    })
  })

  describe('Logging', () => {
    it('logs container creation', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('docker --version')) return 'Docker version 20.0.0'
        if (cmd.includes('docker pull')) return undefined
        if (cmd.includes('docker run')) return 'abc123\n'
        if (cmd.includes('docker stop')) return undefined
        if (cmd.includes('docker rm')) return undefined
        throw new Error(`Unexpected mock call: ${cmd}`)
      })

      const consoleLogSpy = vi.spyOn(console, 'log')

      const config: EnvironmentConfig = {
        runId: 'test-run',
        taskId: 'task',
        repoPath: '/repo'
      }

      await executor.createEnvironment(config)

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\[executor\/docker\] Created container/)
      )

      consoleLogSpy.mockRestore()
    })

    it('logs container destruction', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('docker --version')) return 'Docker version 20.0.0'
        if (cmd.includes('docker pull')) return undefined
        if (cmd.includes('docker run')) return 'abc123\n'
        if (cmd.includes('docker stop')) return undefined
        if (cmd.includes('docker rm')) return undefined
        throw new Error(`Unexpected mock call: ${cmd}`)
      })

      const consoleLogSpy = vi.spyOn(console, 'log')

      const config: EnvironmentConfig = {
        runId: 'test-run',
        taskId: 'task',
        repoPath: '/repo'
      }

      const env = await executor.createEnvironment(config)
      consoleLogSpy.mockClear()

      await executor.destroyEnvironment(env)

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\[executor\/docker\] Destroyed container/)
      )

      consoleLogSpy.mockRestore()
    })
  })
})
