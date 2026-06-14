import { describe, expect, it } from "vitest";
import { MemoryTranscriptRepository } from "./MemoryTranscriptRepository.js";
import type { TaskRecord } from "./types.js";

describe("MemoryTranscriptRepository", () => {
  it("persists sessions and orders message parts by session sequence", async () => {
    const repository = new MemoryTranscriptRepository({
      now: () => new Date("2026-05-15T00:00:00.000Z"),
    });

    await repository.appendMessage(createMessageInput("first", "user"));
    await repository.appendMessageToExistingSession({
      sessionId: "session-1",
      runId: "run-1",
      role: "assistant",
      dedupeKey: "second",
      parts: [{ type: "text", content: { text: "hello" } }],
    });

    const transcript = await repository.listTranscript({
      sessionId: "session-1",
      runId: "run-1",
    });

    expect(transcript.messages).toHaveLength(2);
    expect(transcript.messages[0]?.parts[0]?.sessionSequence).toBe(1);
    expect(transcript.messages[1]?.parts[0]?.sessionSequence).toBe(2);
  });

  it("dedupes repeated message appends without advancing sequence", async () => {
    const repository = new MemoryTranscriptRepository();

    const first = await repository.appendMessage(
      createMessageInput("same", "user"),
    );
    const duplicate = await repository.appendMessage(
      createMessageInput("same", "user"),
    );
    const transcript = await repository.listTranscript({
      sessionId: "session-1",
      runId: "run-1",
    });

    expect(duplicate.id).toBe(first.id);
    expect(transcript.messages).toHaveLength(1);
    expect(transcript.nextCursor).toBeNull();
  });

  it("lists sessions scoped by user", async () => {
    const repository = new MemoryTranscriptRepository();

    await repository.appendMessage(
      createMessageInput("user-1-message", "user"),
    );
    await repository.appendMessage({
      ...createMessageInput("user-2-message", "user"),
      sessionId: "session-2",
      userId: "user-2",
    });

    const result = await repository.listSessions("user-1");

    expect(result.tasks).toHaveLength(1);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.id).toBe("session-1");
  });

  it("omits archived tasks and their sessions from session lists", async () => {
    const repository = new MemoryTranscriptRepository({
      now: () => new Date("2026-05-15T00:00:00.000Z"),
    });

    await repository.appendMessage(
      createMessageInput("active-message", "user"),
    );
    await repository.appendMessage({
      ...createMessageInput("archived-message", "user"),
      sessionId: "archived-session",
      taskId: "archived-task",
    });
    markTaskArchived(repository, "archived-task", "2026-05-15T00:00:01.000Z");

    const result = await repository.listSessions("user-1");

    expect(result.tasks.map((task) => task.id)).toEqual(["session-1"]);
    expect(result.sessions.map((session) => session.id)).toEqual(["session-1"]);
  });

  it("archives sessions through the repository contract", async () => {
    const repository = new MemoryTranscriptRepository({
      now: () => new Date("2026-05-15T00:00:01.000Z"),
    });
    await repository.appendMessage(
      createMessageInput("active-message", "user"),
    );

    const archived = await repository.archiveSession("user-1", "session-1");
    const result = await repository.listSessions("user-1");
    const archivedSessions = await repository.listArchivedSessions("user-1");

    expect(archived?.archivedAt).toBe("2026-05-15T00:00:01.000Z");
    expect(result.tasks).toHaveLength(1);
    expect(result.sessions).toHaveLength(0);
    expect(archivedSessions.map((session) => session.id)).toEqual([
      "session-1",
    ]);
  });

  it("tracks title source and blocks generated overwrites after rename", async () => {
    const repository = new MemoryTranscriptRepository();
    await repository.ensureSession({
      sessionId: "session-1",
      userId: "user-1",
      title: "Generated Title",
      titleSource: "generated",
    });

    const renamed = await repository.renameSessionTitle({
      userId: "user-1",
      sessionId: "session-1",
      title: "My Custom Title",
      titleSource: "user",
    });
    const generated = await repository.updateGeneratedSessionTitle({
      userId: "user-1",
      sessionId: "session-1",
      title: "Ignored Title",
      titleSource: "generated",
    });
    const result = await repository.listSessions("user-1");

    expect(renamed?.titleSource).toBe("user");
    expect(generated).toBeNull();
    expect(result.sessions[0]?.title).toBe("My Custom Title");
  });

  it("updates persisted session status", async () => {
    const repository = new MemoryTranscriptRepository();
    await repository.ensureSession({
      sessionId: "session-1",
      userId: "user-1",
      title: "Run task",
      status: "running",
    });

    const updated = await repository.updateSessionStatus({
      userId: "user-1",
      sessionId: "session-1",
      status: "completed",
    });

    expect(updated?.status).toBe("completed");
    expect((await repository.listSessions("user-1")).sessions[0]?.status).toBe(
      "completed",
    );
  });

  it("orders pinned sessions and clears pin state when archived", async () => {
    const repository = new MemoryTranscriptRepository({
      now: () => new Date("2026-05-15T00:00:01.000Z"),
    });
    await repository.ensureSession({
      sessionId: "session-1",
      userId: "user-1",
      title: "Pinned Title",
    });

    const pinned = await repository.pinSession("user-1", "session-1");
    const archived = await repository.archiveSession("user-1", "session-1");

    expect(pinned?.pinnedAt).toBe("2026-05-15T00:00:01.000Z");
    expect(archived?.pinnedAt).toBeNull();
    expect(archived?.archivedAt).toBe("2026-05-15T00:00:01.000Z");
  });

  it("preserves omitted nullable metadata and clears explicit nulls", async () => {
    const repository = new MemoryTranscriptRepository();

    await repository.ensureSession({
      sessionId: "session-1",
      userId: "user-1",
      workspaceId: "workspace-1",
      title: "Original title",
      repository: "acme/legioncode",
      activeRunId: "run-1",
    });

    const preserved = await repository.ensureSession({
      sessionId: "session-1",
      userId: "user-1",
    });

    expect(preserved.workspaceId).toBe("workspace-1");
    expect(preserved.repository).toBe("acme/legioncode");
    expect(preserved.activeRunId).toBe("run-1");
    expect(preserved.title).toBe("Original title");

    const cleared = await repository.ensureSession({
      sessionId: "session-1",
      userId: "user-1",
      workspaceId: null,
      repository: null,
      activeRunId: null,
    });

    expect(cleared.workspaceId).toBeNull();
    expect(cleared.repository).toBeNull();
    expect(cleared.activeRunId).toBeNull();
    expect(cleared.title).toBe("Original title");
    expect(cleared.titleSource).toBe("generated");
  });

  it("does not hydrate another user's transcript", async () => {
    const repository = new MemoryTranscriptRepository();

    await repository.appendMessage(
      createMessageInput("user-1-message", "user"),
    );

    const transcript = await repository.listTranscript({
      sessionId: "session-1",
      userId: "user-2",
      runId: "run-1",
    });

    expect(transcript.messages).toHaveLength(0);
  });
});

function createMessageInput(dedupeKey: string, role: "user" | "assistant") {
  return {
    sessionId: "session-1",
    runId: "run-1",
    userId: "user-1",
    workspaceId: "workspace-1",
    title: "Build transcript",
    repository: "acme/legioncode",
    activeRunId: "run-1",
    status: "running" as const,
    role,
    dedupeKey,
    parts: [{ type: "text" as const, content: { text: dedupeKey } }],
  };
}

function markTaskArchived(
  repository: MemoryTranscriptRepository,
  taskId: string,
  archivedAt: string,
): void {
  const state = repository as unknown as {
    tasks: Map<string, TaskRecord>;
  };
  const task = state.tasks.get(taskId);
  if (!task) {
    throw new Error(`Missing task in test setup: ${taskId}`);
  }
  state.tasks.set(taskId, {
    ...task,
    status: "archived",
    archivedAt,
  });
}
