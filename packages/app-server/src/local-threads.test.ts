import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
  LocalWorkspaceGrantSchema,
  WorkspaceIdSchema,
  LifecycleEventSchema,
  type LifecycleEvent,
} from "@repo/platform-protocol";
import { LocalPersistence } from "@repo/event-store/local";

import { LocalThreadService } from "./local-threads.js";
import { LocalApprovalService } from "./local-approvals.js";

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
    const storageDirectory = await mkdtemp(
      join(tmpdir(), "legioncode-threads-"),
    );
    let persistence: LocalPersistence | undefined;
    try {
      persistence = new LocalPersistence({ storageDirectory });
      const first = new LocalThreadService({
        events: persistence.events,
        getWorkspace: async () => workspace,
      });
      const created = await first.create({ title: "Local work" });
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
    const storageDirectory = await mkdtemp(
      join(tmpdir(), "legioncode-threads-"),
    );
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
      await expect(otherService.archive(thread.id)).rejects.toThrow(
        "not found",
      );

      const store = persistence.lifecycleEvents;
      const envelope = {
        threadId: thread.id,
        turnId: "trn_localapproval",
        runAttemptId: "attempt_localapproval",
        producer: { kind: "runtime_kernel", id: "approval-fixture" },
        schemaVersion: 1,
        createdAt: "2026-09-20T00:00:00.000Z",
      };
      const append = async (sequence: number, event: Record<string, unknown>) =>
        store.append(
          LifecycleEventSchema.parse({
            ...envelope,
            sequence,
            eventId: `evt_localapproval${sequence}`,
            idempotencyKey: `approval-fixture:${sequence}`,
            ...event,
          }),
        );
      const tool = await append(1, {
        type: "tool_call.started",
        itemId: "itm_localtool",
        toolCallId: "toolcall_localtool",
        payload: { toolName: "edit_file", input: {} },
      });
      await append(2, {
        type: "item.started",
        itemId: "itm_localapproval",
        payload: { kind: "approval_request", parentItemId: "itm_localtool" },
      });
      await append(3, {
        type: "approval.requested",
        itemId: "itm_localapproval",
        approvalId: "appr_localapproval",
        payload: {
          question: "Allow edit?",
          options: [{ id: "approve", label: "Allow", description: null }],
        },
      });
      const request = {
        turnId: tool.turnId,
        approvalId: "appr_localapproval" as const,
        decision: "denied" as const,
        decidedBy: null,
        reason: "Keep files unchanged",
      };
      let resolutions = 0;
      const resolveApproval = async (
        _turnId: unknown,
        _approvalId: unknown,
        resolution: { decision: string; decidedBy: unknown; reason: unknown },
      ) => {
        resolutions++;
        await append(4, {
          type: "approval.decided",
          itemId: "itm_localapproval",
          approvalId: "appr_localapproval",
          payload: {
            status: resolution.decision,
            decidedBy: resolution.decidedBy,
            reason: resolution.reason,
          },
        });
      };
      const denied = new LocalApprovalService({
        lifecycleEvents: store,
        threads: otherService,
        resolveApproval,
      });
      await expect(denied.submitLifecycleApproval(request)).rejects.toThrow(
        "not found",
      );
      expect(resolutions).toBe(0);
      const approvals = new LocalApprovalService({
        lifecycleEvents: store,
        threads: service,
        resolveApproval,
      });
      await expect(
        approvals.submitLifecycleApproval({
          ...request,
          decidedBy: "usr_foreignuser",
        }),
      ).rejects.toThrow("another local user");
      await expect(
        approvals.submitLifecycleApproval({
          ...request,
          approvalId: "appr_missing",
        }),
      ).rejects.toThrow("missing");
      const original = await store.replay({
        turnId: tool.turnId,
        afterSequence: null,
        limit: 1_000,
      });
      for (const event of original.events) {
        await store.append(
          LifecycleEventSchema.parse({
            ...event,
            turnId: "trn_staleapproval",
            eventId: `${event.eventId}stale`,
            idempotencyKey: `${event.idempotencyKey}:stale`,
          }),
        );
      }
      await append(4, {
        type: "turn.started",
        eventId: "evt_staleattempt4",
        turnId: "trn_staleapproval",
        runAttemptId: "attempt_newapproval",
        payload: {},
      });
      await expect(
        approvals.submitLifecycleApproval({
          ...request,
          turnId: "trn_staleapproval",
        }),
      ).rejects.toThrow("no longer active");
      expect(resolutions).toBe(0);
      const receipts: LifecycleEvent[] = await Promise.all([
        approvals.submitLifecycleApproval(request),
        approvals.submitLifecycleApproval(request),
      ]);
      expect(receipts[0]).toEqual(receipts[1]);
      expect(receipts[0]).toMatchObject({
        type: "approval.decided",
        payload: { status: "denied" },
      });
      expect(resolutions).toBe(1);
      await expect(
        approvals.submitLifecycleApproval({ ...request, decision: "approved" }),
      ).rejects.toThrow("different decision");
      const restarted = new LocalApprovalService({
        lifecycleEvents: store,
        threads: service,
        resolveApproval,
      });
      await expect(restarted.submitLifecycleApproval(request)).resolves.toEqual(
        receipts[0],
      );
      expect(resolutions).toBe(1);
    } finally {
      persistence?.close();
      await rm(storageDirectory, { recursive: true, force: true });
    }
  });
});
