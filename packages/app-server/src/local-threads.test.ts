import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { EVENT_SCHEMA_VERSION, LocalWorkspaceGrantSchema, WorkspaceIdSchema, RunSchema } from "@repo/platform-protocol";
import { LocalPersistence } from "@repo/event-store/local";

import { LocalThreadService } from "./local-threads.js";

const workspace = LocalWorkspaceGrantSchema.parse({
  workspaceId: "wrk_localworkspace",
  displayName: "repository",
  repositoryIdentity: "github.com/example/repository",
  branch: "main",
  readiness: "ready",
  capabilities: ["filesystem", "git"],
  reason: null,
  grantedAt: "2026-09-20T00:00:00.000Z",
});

describe("LocalThreadService", () => {
  it("replays a durable thread projection after service restart", async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), "legioncode-threads-"));
    let persistence: LocalPersistence | undefined;
    try {
      persistence = new LocalPersistence({ storageDirectory });
      const first = new LocalThreadService({
        events: persistence.events,
        getWorkspace: async () => workspace,
      });
      const created = await first.create({ title: "Local work" });
      const now = new Date().toISOString();
      const run = RunSchema.parse({
        id: `run_${crypto.randomUUID().replaceAll("-", "")}`, threadId: created.id,
        userId: created.userId, workspaceId: created.workspaceId, status: "queued", mode: "ask",
        providerId: "openai", modelId: "gpt-4o", workerId: "worker_localtest", permissionProfileId: "perm_readonly",
        startedAt: null, completedAt: null, createdAt: now, updatedAt: now, lastEventSequence: 0,
      });
      await persistence.events.append({
        threadId: created.id, workspaceId: created.workspaceId, runId: run.id,
        scopeType: "run", scopeId: run.id, type: "run.created", payload: { run },
        idempotencyKey: `run-created:${run.id}`, producer: { kind: "runtime_kernel", id: "local-test" },
        schemaVersion: EVENT_SCHEMA_VERSION,
      });
      const renamed = await first.rename(created.id, { title: "Renamed work" });
      const archived = await first.archive(renamed.id);
      expect(archived.status).toBe("archived");

      persistence.close();
      persistence = new LocalPersistence({ storageDirectory });
      const reopened = new LocalThreadService({
        events: persistence.events,
        getWorkspace: async () => workspace,
      });
      await expect(reopened.list()).resolves.toEqual([archived]);
      await expect(reopened.get(created.id)).resolves.toEqual(archived);
      await expect(reopened.unarchive(created.id)).resolves.toMatchObject({
        id: created.id,
        title: "Renamed work",
        status: "active",
        archivedAt: null,
      });
    } finally {
      persistence?.close();
      await rm(storageDirectory, { recursive: true, force: true });
    }
  });

  it("never reads or mutates a thread through a different workspace grant", async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), "legioncode-threads-"));
    let persistence: LocalPersistence | undefined;
    try {
      persistence = new LocalPersistence({ storageDirectory });
      const service = new LocalThreadService({
        events: persistence.events,
        getWorkspace: async () => workspace,
      });
      const thread = await service.create({});
      const otherWorkspace = {
        ...workspace,
        workspaceId: WorkspaceIdSchema.parse("wrk_otherworkspace"),
      };
      const otherService = new LocalThreadService({
        events: persistence.events,
        getWorkspace: async () => otherWorkspace,
      });
      await expect(otherService.list()).resolves.toEqual([]);
      await expect(otherService.get(thread.id)).rejects.toThrow("not found");
      await expect(otherService.archive(thread.id)).rejects.toThrow("not found");
    } finally {
      persistence?.close();
      await rm(storageDirectory, { recursive: true, force: true });
    }
  });
});
