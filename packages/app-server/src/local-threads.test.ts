import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { LocalWorkspaceGrantSchema, WorkspaceIdSchema } from "@repo/platform-protocol";

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
    try {
      const first = new LocalThreadService({
        storageDirectory,
        getWorkspace: async () => workspace,
      });
      const created = await first.create({ title: "Local work" });
      const renamed = await first.rename(created.id, { title: "Renamed work" });
      const archived = await first.archive(renamed.id);
      expect(archived.status).toBe("archived");

      const reopened = new LocalThreadService({
        storageDirectory,
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
      await rm(storageDirectory, { recursive: true, force: true });
    }
  });

  it("never reads or mutates a thread through a different workspace grant", async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), "legioncode-threads-"));
    try {
      const service = new LocalThreadService({
        storageDirectory,
        getWorkspace: async () => workspace,
      });
      const thread = await service.create({});
      const otherWorkspace = {
        ...workspace,
        workspaceId: WorkspaceIdSchema.parse("wrk_otherworkspace"),
      };
      const otherService = new LocalThreadService({
        storageDirectory,
        getWorkspace: async () => otherWorkspace,
      });
      await expect(otherService.list()).resolves.toEqual([]);
      await expect(otherService.get(thread.id)).rejects.toThrow("not found");
      await expect(otherService.archive(thread.id)).rejects.toThrow("not found");
    } finally {
      await rm(storageDirectory, { recursive: true, force: true });
    }
  });
});
