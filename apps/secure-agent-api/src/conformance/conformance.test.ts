/**
 * Conformance Tests - Validate portability boundary adherence.
 *
 * These tests ensure:
 * 1. Port contracts are honored end-to-end
 * 2. No Cloudflare primitives leak into core logic
 * 3. Error mapping is correct across boundaries
 * 4. Identity (runId/sessionId) flows correctly
 *
 * Aligns to:
 * - Charter 46: Boundary enforcement
 * - Plan 59: Portability verification
 * - SHA-24: End-to-End Wiring & Conformance Gate
 */

import type { DurableObjectState } from "@cloudflare/workers-types";
import type { Sandbox } from "@cloudflare/sandbox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IPlugin, PluginResult, ToolDefinition } from "../interfaces/types";
import { composeRuntime } from "../factories/RuntimeCompositionFactory";
import { UnsupportedExecutionBackendError } from "../adapters/AgentRuntimeAdapterFactory";
import type {
  ArtifactStorePort,
  SandboxExecutionPort,
  SessionStatePort,
} from "../ports";

interface DurableObjectStorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(keys: string | string[]): Promise<void>;
  list<T>(options?: { prefix?: string }): Promise<Map<string, T>>;
}

class MockDurableObjectStorage implements DurableObjectStorageLike {
  private readonly store = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.store.get(key);
    return value as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }

  async delete(keys: string | string[]): Promise<void> {
    const keyArray = Array.isArray(keys) ? keys : [keys];
    for (const key of keyArray) {
      this.store.delete(key);
    }
  }

  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    const result = new Map<string, T>();
    const prefix = options?.prefix;
    for (const [key, value] of this.store.entries()) {
      if (!prefix || key.startsWith(prefix)) {
        result.set(key, value as T);
      }
    }
    return result;
  }
}

class MockDurableObjectState {
  storage: DurableObjectStorageLike = new MockDurableObjectStorage();
}

interface R2ObjectMock {
  key: string;
  version: string;
  size: number;
  etag: string;
  uploaded: Date;
  httpMetadata?: Record<string, string>;
  customMetadata?: Record<string, string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface R2ObjectsMock {
  objects: R2ObjectMock[];
  delimitedPrefixes?: string[];
  isTruncated: boolean;
  cursor?: string;
}

class MockR2Bucket {
  private readonly objects = new Map<
    string,
    {
      data: Uint8Array;
      uploaded: Date;
      contentType: string;
    }
  >();

  async head(key: string): Promise<R2ObjectMock | null> {
    const obj = this.objects.get(key);
    if (!obj) {
      return null;
    }
    return this.toR2Object(key, obj);
  }

  async get(key: string): Promise<R2ObjectMock | null> {
    const obj = this.objects.get(key);
    if (!obj) {
      return null;
    }
    return this.toR2Object(key, obj);
  }

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | Uint8Array | string,
    options?: { httpMetadata?: Record<string, string> },
  ): Promise<R2ObjectMock> {
    const contentType =
      options?.httpMetadata?.["content-type"] ?? "application/octet-stream";
    const uploaded = new Date();
    const data = this.toUint8Array(value);
    const record = { data, uploaded, contentType };
    this.objects.set(key, record);
    return this.toR2Object(key, record);
  }

  async delete(keys: string | string[]): Promise<void> {
    const keyArray = Array.isArray(keys) ? keys : [keys];
    for (const key of keyArray) {
      this.objects.delete(key);
    }
  }

  async list(options?: { prefix?: string }): Promise<R2ObjectsMock> {
    const prefix = options?.prefix;
    const objects: R2ObjectMock[] = [];

    for (const [key, value] of this.objects.entries()) {
      if (!prefix || key.startsWith(prefix)) {
        objects.push(this.toR2Object(key, value));
      }
    }

    return {
      objects,
      delimitedPrefixes: [],
      isTruncated: false,
    };
  }

  private toR2Object(
    key: string,
    value: { data: Uint8Array; uploaded: Date; contentType: string },
  ): R2ObjectMock {
    return {
      key,
      version: "v1",
      size: value.data.length,
      etag: "etag",
      uploaded: value.uploaded,
      httpMetadata: { "content-type": value.contentType },
      customMetadata: {},
      arrayBuffer: async () => value.data.buffer as ArrayBuffer,
    };
  }

  private toUint8Array(
    value: ReadableStream | ArrayBuffer | Uint8Array | string,
  ): Uint8Array {
    if (value instanceof Uint8Array) {
      return value;
    }
    if (value instanceof ArrayBuffer) {
      return new Uint8Array(value);
    }
    if (typeof value === "string") {
      return new TextEncoder().encode(value);
    }
    const typeName =
      value && typeof value === "object" && value.constructor
        ? value.constructor.name
        : typeof value;
    throw new TypeError(
      `MockR2Bucket.toUint8Array does not support input type: ${typeName}`,
    );
  }
}

class MockPlugin implements IPlugin {
  readonly name = "MockPlugin";
  readonly tools: ToolDefinition[] = [];

  async execute(
    _sandbox: Sandbox,
    payload: unknown,
  ): Promise<PluginResult> {
    return {
      success: true,
      output: JSON.stringify(payload),
    };
  }
}

describe("Portability Conformance", () => {
  let durableObjectState: MockDurableObjectState;
  let runtime: ReturnType<typeof composeRuntime>;
  let r2Bucket: MockR2Bucket;

  beforeEach(() => {
    durableObjectState = new MockDurableObjectState();
    r2Bucket = new MockR2Bucket();
    runtime = composeRuntime({
      durableObjectState: durableObjectState as unknown as DurableObjectState,
      sandbox: {} as Sandbox,
      plugins: new Map<string, IPlugin>([["MockPlugin", new MockPlugin()]]),
      r2Bucket,
    });
  });

  describe("Port Contracts", () => {
    it("should return canonical port abstractions", () => {
      expect(runtime.executionPort).toBeDefined();
      expect(runtime.sessionPort).toBeDefined();
      expect(runtime.artifactPort).toBeDefined();
      expect(typeof runtime.executionPort.executeTask).toBe("function");
      expect(typeof runtime.sessionPort.createSession).toBe("function");
      expect(typeof runtime.artifactPort.upload).toBe("function");
    });

    it("should implement SandboxExecutionPort contract", () => {
      const port = runtime.executionPort;
      expect(port).toHaveProperty("executeTask");
      expect(port).toHaveProperty("cancelTask");
      expect(port).toHaveProperty("getHealth");
      expect(port).toHaveProperty("cleanup");
    });

    it("should implement SessionStatePort contract", () => {
      const port = runtime.sessionPort;
      expect(port).toHaveProperty("createSession");
      expect(port).toHaveProperty("getSession");
      expect(port).toHaveProperty("updateSession");
      expect(port).toHaveProperty("saveSnapshot");
      expect(port).toHaveProperty("loadSnapshot");
      expect(port).toHaveProperty("deleteSession");
    });

    it("should implement ArtifactStorePort contract", () => {
      const port = runtime.artifactPort;
      expect(port).toHaveProperty("upload");
      expect(port).toHaveProperty("download");
      expect(port).toHaveProperty("getMetadata");
      expect(port).toHaveProperty("list");
      expect(port).toHaveProperty("delete");
      expect(port).toHaveProperty("cleanup");
    });
  });

  describe("Boundary Isolation", () => {
    it("should not expose platform types in core contracts", () => {
      const executionPort: SandboxExecutionPort = runtime.executionPort;
      const sessionPort: SessionStatePort = runtime.sessionPort;
      const artifactPort: ArtifactStorePort = runtime.artifactPort;

      expect(executionPort).toBeDefined();
      expect(sessionPort).toBeDefined();
      expect(artifactPort).toBeDefined();
    });

    it("should handle session lifecycle via SessionStatePort only", async () => {
      const sessionPort = runtime.sessionPort;

      const session = await sessionPort.createSession(
        "test-session-id",
        "test-run-id",
      );
      expect(session.sessionId).toBe("test-session-id");
      expect(session.status).toBe("active");

      const retrieved = await sessionPort.getSession("test-session-id");
      expect(retrieved?.sessionId).toBe("test-session-id");

      await sessionPort.deleteSession("test-session-id");
      const deleted = await sessionPort.getSession("test-session-id");
      expect(deleted).toBeNull();
    });

    it("should handle artifact lifecycle via ArtifactStorePort only", async () => {
      const artifactPort = runtime.artifactPort;
      const data = new Uint8Array([1, 2, 3, 4, 5]);

      const metadata = await artifactPort.upload({
        sessionId: "test-session",
        contentType: "application/octet-stream",
        data,
      });

      expect(metadata.sessionId).toBe("test-session");
      expect(metadata.size).toBe(5);

      const downloaded = await artifactPort.download(metadata.id, "test-session");
      expect(downloaded).toEqual(data);

      const deleted = await artifactPort.delete(metadata.id, "test-session");
      expect(deleted).toBe(true);
      expect(await artifactPort.download(metadata.id, "test-session")).toBeNull();
    });
  });

  describe("Execution Contract", () => {
    it("should route plugin execution through sandbox execution port", async () => {
      const result = await runtime.executionPort.executeTask("session-1", {
        taskId: "task-1",
        action: "MockPlugin.execute",
        params: { action: "mock", command: "echo hi", runId: "run-1" },
      });

      expect(result.taskId).toBe("task-1");
      expect(result.status).toBe("success");
      expect(result.output).toContain("echo hi");
    });

    it("should classify unknown actions as deterministic failures", async () => {
      const result = await runtime.executionPort.executeTask("session-1", {
        taskId: "task-2",
        action: "MissingPlugin.execute",
        params: {},
      });

      expect(result.status).toBe("failure");
      expect(result.error?.code).toBe("PLUGIN_NOT_FOUND");
    });
  });

  describe("Error Handling", () => {
    it("should return null for missing sessions without leaking storage details", async () => {
      const result = await runtime.sessionPort.getSession("non-existent-session");
      expect(result).toBeNull();
    });

    it("should enforce cross-session artifact access isolation", async () => {
      const warnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const metadata = await runtime.artifactPort.upload({
        sessionId: "session-a",
        contentType: "application/octet-stream",
        data: new Uint8Array([1, 2, 3]),
      });

      const result = await runtime.artifactPort.download(metadata.id, "session-b");
      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[ArtifactStore] Unauthorized download attempt:"),
      );
    });
  });

  describe("Composition Correctness", () => {
    it("should compose all ports from a single call", () => {
      expect(runtime).toHaveProperty("executionPort");
      expect(runtime).toHaveProperty("sessionPort");
      expect(runtime).toHaveProperty("artifactPort");
      expect(runtime.executionPort).not.toBeNull();
      expect(runtime.sessionPort).not.toBeNull();
      expect(runtime.artifactPort).not.toBeNull();
    });

    it("should create independent adapter instances per call", () => {
      const runtime2 = composeRuntime({
        durableObjectState: durableObjectState as unknown as DurableObjectState,
        sandbox: {} as Sandbox,
        plugins: new Map<string, IPlugin>([["MockPlugin", new MockPlugin()]]),
        r2Bucket,
      });

      expect(runtime.executionPort).not.toBe(runtime2.executionPort);
      expect(runtime.sessionPort).not.toBe(runtime2.sessionPort);
      expect(runtime.artifactPort).not.toBe(runtime2.artifactPort);
    });

    it("should default execution backend routing to cloudflare_sandbox", async () => {
      const defaultRuntime = composeRuntime({
        durableObjectState: durableObjectState as unknown as DurableObjectState,
        sandbox: {} as Sandbox,
        plugins: new Map<string, IPlugin>([["MockPlugin", new MockPlugin()]]),
        r2Bucket,
      });

      const result = await defaultRuntime.executionPort.executeTask("session-1", {
        taskId: "task-default-backend",
        action: "MockPlugin.execute",
        params: {
          action: "mock",
          command: "echo backend",
          runId: "run-default",
        },
      });

      expect(result.status).toBe("success");
      expect(result.output).toContain("echo backend");
    });

    it("should reject unsupported execution backends deterministically", () => {
      expect(() =>
        composeRuntime({
          durableObjectState:
            durableObjectState as unknown as DurableObjectState,
          sandbox: {} as Sandbox,
          plugins: new Map<string, IPlugin>([
            ["MockPlugin", new MockPlugin()],
          ]),
          r2Bucket,
          executionBackend: "e2b",
        }),
      ).toThrow(UnsupportedExecutionBackendError);
      expect(() =>
        composeRuntime({
          durableObjectState:
            durableObjectState as unknown as DurableObjectState,
          sandbox: {} as Sandbox,
          plugins: new Map<string, IPlugin>([
            ["MockPlugin", new MockPlugin()],
          ]),
          r2Bucket,
          executionBackend: "daytona",
        }),
      ).toThrow(UnsupportedExecutionBackendError);
    });
  });
});
