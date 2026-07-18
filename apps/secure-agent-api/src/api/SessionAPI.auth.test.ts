import { describe, expect, it } from "vitest";
import {
  handleCreateSession,
  handleDeleteSession,
  handleExecuteTask,
  handleResumeSession,
} from "./SessionAPI";

interface SessionRecord {
  runId: string;
  taskId: string;
  repoPath: string;
  expiresAt: number;
  token: string;
  createdAt: number;
  workspaceScope: WorkspaceScope;
  lease: {
    leaseId: string;
    sandboxId: string;
    generation: number;
  };
}

interface WorkspaceScope {
  runId: string;
  threadId: string;
  turnId: string;
  runAttemptId: string;
  workspaceId: string;
  root: string;
}

interface SessionLogEntry {
  taskId?: string;
  timestamp: number;
  level: "info" | "warn" | "error" | "debug";
  message: string;
  source?: "stdout" | "stderr";
}

interface RuntimeStoreMock extends Record<string, unknown> {
  storeExecutionSession: (
    sessionId: string,
    session: SessionRecord,
  ) => Promise<void>;
  getExecutionSession: (sessionId: string) => Promise<SessionRecord | null>;
  appendExecutionLog: (
    sessionId: string,
    entry: SessionLogEntry,
  ) => Promise<void>;
  getExecutionLogs: (
    sessionId: string,
    since?: number,
    taskId?: string,
  ) => Promise<SessionLogEntry[]>;
  deleteExecutionSession: (sessionId: string) => Promise<void>;
  executionPort: {
    executeTask: (
      sessionId: string,
      input: {
        taskId: string;
        action: string;
        params: Record<string, unknown>;
        timeout?: number;
        retryable?: boolean;
      },
    ) => Promise<{
      taskId: string;
      status: "success" | "failure" | "timeout" | "cancelled" | "sandbox_unavailable";
      output?: string;
      error?: {
        code: string;
        message: string;
        details?: unknown;
      };
      metrics?: {
        duration: number;
      };
    }>;
  };
}

function createRuntimeStoreMock(): RuntimeStoreMock {
  const sessions = new Map<string, SessionRecord>();
  const logs = new Map<string, SessionLogEntry[]>();

  return {
    async storeExecutionSession(sessionId, session) {
      sessions.set(sessionId, session);
      logs.set(sessionId, []);
    },
    async getExecutionSession(sessionId) {
      return sessions.get(sessionId) ?? null;
    },
    async appendExecutionLog(sessionId, entry) {
      const entries = logs.get(sessionId) ?? [];
      entries.push(entry);
      logs.set(sessionId, entries);
    },
    async getExecutionLogs(sessionId, since, taskId) {
      const entries = logs.get(sessionId) ?? [];
      return entries.filter((entry) => {
        const matchesSince = since === undefined || entry.timestamp > since;
        const matchesTask = taskId === undefined || entry.taskId === taskId;
        return matchesSince && matchesTask;
      });
    },
    async deleteExecutionSession(sessionId) {
      sessions.delete(sessionId);
      logs.delete(sessionId);
    },
    executionPort: {
      async executeTask(sessionId, input) {
        return {
          taskId: input.taskId,
          leaseId: "lease:test:attempt-1",
          correlationId: "test-correlation",
          status: "success",
          retryable: false,
          output: `executed ${input.action} for ${sessionId}`,
          metrics: { duration: 12 },
        };
      },
    },
  };
}

function createSessionRequest(): Request {
  return new Request("http://localhost/api/v1/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      runId: "run-auth-1",
      taskId: "task-auth-1",
      repoPath: "workspace/repo",
      workspaceScope: {
        runId: "run-auth-1",
        threadId: "thread-auth-1",
        turnId: "turn-auth-1",
        runAttemptId: "attempt-auth-1",
        workspaceId: "workspace-auth-1",
        root: "/runs/auth-1",
      },
    }),
  });
}

const scopedWorkspace: WorkspaceScope = {
  runId: "run-scoped-1",
  threadId: "thread-scoped-1",
  turnId: "turn-scoped-1",
  runAttemptId: "attempt_scoped_000001",
  workspaceId: "wrk_scoped_000001",
  root: "/runs/scoped-1",
};

function createScopedSessionRequest(): Request {
  return new Request("http://localhost/api/v1/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      runId: scopedWorkspace.runId,
      taskId: "task-scoped-1",
      repoPath: ".",
      workspaceScope: scopedWorkspace,
    }),
  });
}

async function createSession(
  runtime: RuntimeStoreMock,
): Promise<{ sessionId: string; token: string }> {
  const response = await handleCreateSession(createSessionRequest(), runtime);
  expect(response.status).toBe(201);
  return (await response.json()) as { sessionId: string; token: string };
}

interface ErrorBody {
  code: string;
}

interface DeleteBody {
  success: boolean;
}

function createDeleteRequest(sessionId: string, authHeader?: string): Request {
  const headers: Record<string, string> = {};
  if (authHeader) {
    headers.Authorization = authHeader;
  }

  return new Request(`http://localhost/api/v1/session/${sessionId}`, {
    method: "DELETE",
    headers,
  });
}

function createResumeRequest(
  sessionId: string,
  lease: SessionRecord["lease"],
  workspaceScope: WorkspaceScope = {
    runId: "run-auth-1",
    threadId: "thread-auth-1",
    turnId: "turn-auth-1",
    runAttemptId: "attempt-auth-1",
    workspaceId: "workspace-auth-1",
    root: "/runs/auth-1",
  },
): Request {
  return new Request(
    `http://localhost/api/v1/session/${encodeURIComponent(sessionId)}/resume`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceScope,
        lease: {
          leaseId: lease.leaseId,
          sandboxId: lease.sandboxId,
          generation: lease.generation,
        },
      }),
    },
  );
}

function createExecuteRequest(sessionId: string, authHeader?: string): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authHeader) {
    headers.Authorization = authHeader;
  }

  return new Request("http://localhost/api/v1/execute", {
    method: "POST",
    headers,
    body: JSON.stringify({
      sessionId,
      taskId: "task-execute-auth",
      action: "node.execute",
      params: {
        action: "run",
        command: "echo hello",
        runId: "run-auth-1",
        workspaceScope: {
          runId: "run-auth-1",
          threadId: "thread-auth-1",
          turnId: "turn-auth-1",
          runAttemptId: "attempt-auth-1",
          workspaceId: "workspace-auth-1",
          root: "/runs/auth-1",
        },
      },
    }),
  });
}

function createScopedExecuteRequest(
  sessionId: string,
  token: string,
  workspaceScope: WorkspaceScope,
): Request {
  return new Request("http://localhost/api/v1/execute", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      sessionId,
      taskId: "task-scoped-execute",
      action: "node.execute",
      params: { workspaceScope },
    }),
  });
}

describe("session auth hardening", () => {
  it("rejects execute without authorization header", async () => {
    const runtime = createRuntimeStoreMock();
    const { sessionId } = await createSession(runtime);
    const response = await handleExecuteTask(
      createExecuteRequest(sessionId),
      runtime,
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as ErrorBody;
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("rejects execute with wrong bearer token", async () => {
    const runtime = createRuntimeStoreMock();
    const { sessionId } = await createSession(runtime);
    const response = await handleExecuteTask(
      createExecuteRequest(sessionId, "Bearer tok_wrong"),
      runtime,
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as ErrorBody;
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("executes authorized requests through the runtime execution port", async () => {
    const runtime = createRuntimeStoreMock();
    const { sessionId, token } = await createSession(runtime);
    const response = await handleExecuteTask(
      createExecuteRequest(sessionId, `Bearer ${token}`),
      runtime,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      taskId: string;
      status: string;
      output?: string;
    };
    expect(body.taskId).toBe("task-execute-auth");
    expect(body.status).toBe("success");
    expect(body.output).toContain("node.execute");
  });

  it("persists the run workspace scope and rejects cross-run execution", async () => {
    const runtime = createRuntimeStoreMock();
    const sessionResponse = await handleCreateSession(
      createScopedSessionRequest(),
      runtime,
    );
    expect(sessionResponse.status).toBe(201);
    const { sessionId, token } = (await sessionResponse.json()) as {
      sessionId: string;
      token: string;
    };

    const mismatchedScope = {
      ...scopedWorkspace,
      runId: "run-scoped-2",
    };
    const rejected = await handleExecuteTask(
      createScopedExecuteRequest(sessionId, token, mismatchedScope),
      runtime,
    );
    expect(rejected.status).toBe(409);
    expect(((await rejected.json()) as ErrorBody).code).toBe(
      "WORKSPACE_SCOPE_MISMATCH",
    );

    const accepted = await handleExecuteTask(
      createScopedExecuteRequest(sessionId, token, scopedWorkspace),
      runtime,
    );
    expect(accepted.status).toBe(200);
  });

  it("publishes signed runtime task events around execution", async () => {
    const runtime = createRuntimeStoreMock();
    const { sessionId, token } = await createSession(runtime);
    const published: Array<{ eventType: string; idempotencyKey: string }> = [];
    const response = await handleExecuteTask(
      createExecuteRequest(sessionId, `Bearer ${token}`),
      runtime,
      {
        async publish(event) {
          published.push({
            eventType: event.eventType,
            idempotencyKey: event.idempotencyKey,
          });
        },
      },
    );

    expect(response.status).toBe(200);
    expect(published).toEqual([
      {
        eventType: "runtime.task.started",
        idempotencyKey: `run-auth-1:${sessionId}:task-execute-auth:runtime.task.started`,
      },
      {
        eventType: "runtime.task.finished",
        idempotencyKey: `run-auth-1:${sessionId}:task-execute-auth:runtime.task.finished`,
      },
    ]);
  });

  it("advances exactly one lease generation after each sandbox loss", async () => {
    const runtime = createRuntimeStoreMock();
    const stored: SessionRecord[] = [];
    const originalStore = runtime.storeExecutionSession;
    runtime.storeExecutionSession = async (sessionId, session) => {
      stored.push(session);
      await originalStore(sessionId, session);
    };
    runtime.executionPort.executeTask = async (_leaseId, input) => ({
      taskId: input.taskId,
      leaseId: "dead-lease",
      correlationId: "dead-correlation",
      status: "sandbox_unavailable",
      retryable: true,
      error: {
        code: "SANDBOX_UNAVAILABLE",
        message: "container exited",
      },
      metrics: { duration: 1 },
    });

    const { sessionId, token } = await createSession(runtime);
    const response = await handleExecuteTask(
      createExecuteRequest(sessionId, `Bearer ${token}`),
      runtime,
    );

    expect(response.status).toBe(503);
    expect(stored).toHaveLength(2);
    expect(stored[1]?.lease.generation).toBe(1);
    expect(stored[1]?.lease.sandboxId).not.toBe(stored[0]?.lease.sandboxId);

    const resume = await handleResumeSession(
      createResumeRequest(sessionId, stored[0]!.lease),
      runtime,
    );
    expect(resume.status).toBe(200);
    const resumed = (await resume.json()) as {
      token: string;
      lease: SessionRecord["lease"];
      replaced: boolean;
    };
    expect(resumed.replaced).toBe(true);
    expect(resumed.lease).toMatchObject(stored[1]!.lease);

    const secondResponse = await handleExecuteTask(
      createExecuteRequest(sessionId, `Bearer ${resumed.token}`),
      runtime,
    );
    expect(secondResponse.status).toBe(503);
    const activeSession = await runtime.getExecutionSession(sessionId);
    expect(activeSession?.lease.generation).toBe(2);
    expect(activeSession?.lease.leaseId).not.toBe(resumed.lease.leaseId);
    expect(activeSession?.lease.sandboxId).not.toBe(resumed.lease.sandboxId);
  });

  it("rejects delete without authorization header", async () => {
    const runtime = createRuntimeStoreMock();
    const { sessionId } = await createSession(runtime);
    const response = await handleDeleteSession(
      createDeleteRequest(sessionId),
      runtime,
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as ErrorBody;
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("rejects malformed bearer format and wrong token", async () => {
    const runtime = createRuntimeStoreMock();
    const { sessionId } = await createSession(runtime);

    const malformed = await handleDeleteSession(
      createDeleteRequest(sessionId, "Token abc123"),
      runtime,
    );
    expect(malformed.status).toBe(401);

    const wrong = await handleDeleteSession(
      createDeleteRequest(sessionId, "Bearer tok_wrong"),
      runtime,
    );
    expect(wrong.status).toBe(401);
  });

  it("allows delete only with matching bearer token", async () => {
    const runtime = createRuntimeStoreMock();
    const { sessionId, token } = await createSession(runtime);
    const response = await handleDeleteSession(
      createDeleteRequest(sessionId, `Bearer ${token}`),
      runtime,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as DeleteBody;
    expect(body.success).toBe(true);
  });

  it("rotates a bearer only for the exact persisted session and lease scope", async () => {
    const runtime = createRuntimeStoreMock();
    const createdResponse = await handleCreateSession(
      createSessionRequest(),
      runtime,
    );
    const created = (await createdResponse.json()) as {
      sessionId: string;
      token: string;
      lease: SessionRecord["lease"];
    };

    const resumedResponse = await handleResumeSession(
      createResumeRequest(created.sessionId, created.lease),
      runtime,
    );
    expect(resumedResponse.status).toBe(200);
    const resumed = (await resumedResponse.json()) as {
      sessionId: string;
      token: string;
      lease: SessionRecord["lease"];
    };
    expect(resumed.sessionId).toBe(created.sessionId);
    expect(resumed.token).not.toBe(created.token);
    expect(resumed.lease).toMatchObject(created.lease);

    const oldToken = await handleExecuteTask(
      createExecuteRequest(created.sessionId, `Bearer ${created.token}`),
      runtime,
    );
    expect(oldToken.status).toBe(401);
    const newToken = await handleExecuteTask(
      createExecuteRequest(created.sessionId, `Bearer ${resumed.token}`),
      runtime,
    );
    expect(newToken.status).toBe(200);
  });

  it("rejects resume when persisted checkout identity mismatches", async () => {
    const runtime = createRuntimeStoreMock();
    const createdResponse = await handleCreateSession(
      createSessionRequest(),
      runtime,
    );
    const created = (await createdResponse.json()) as {
      sessionId: string;
      lease: SessionRecord["lease"];
    };

    const response = await handleResumeSession(
      createResumeRequest(created.sessionId, {
        ...created.lease,
        leaseId: "lease_wrong",
      }),
      runtime,
    );
    expect(response.status).toBe(409);
    expect(((await response.json()) as ErrorBody).code).toBe(
      "SESSION_SCOPE_MISMATCH",
    );
  });

  it("creates exactly one next-generation lease when the persisted secure session is gone", async () => {
    const runtime = createRuntimeStoreMock();
    const createdResponse = await handleCreateSession(
      createSessionRequest(),
      runtime,
    );
    const created = (await createdResponse.json()) as {
      sessionId: string;
      token: string;
      lease: SessionRecord["lease"];
    };
    await handleDeleteSession(
      createDeleteRequest(created.sessionId, `Bearer ${created.token}`),
      runtime,
    );

    const resumedResponse = await handleResumeSession(
      createResumeRequest(created.sessionId, created.lease),
      runtime,
    );
    expect(resumedResponse.status).toBe(200);
    const resumed = (await resumedResponse.json()) as {
      sessionId: string;
      lease: SessionRecord["lease"];
      replaced: boolean;
    };
    expect(resumed.sessionId).toBe(created.sessionId);
    expect(resumed.replaced).toBe(true);
    expect(resumed.lease.generation).toBe(created.lease.generation + 1);
    expect(resumed.lease.leaseId).not.toBe(created.lease.leaseId);
  });
});
