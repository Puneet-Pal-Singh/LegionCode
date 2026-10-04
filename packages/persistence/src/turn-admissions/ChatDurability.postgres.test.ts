import { randomUUID } from "node:crypto";
import {
  PostgresTurnAdmissionRepository,
  PostgresTranscriptRepository,
  PostgresLifecycleEventStore,
  PostgresMigrationLedger,
  PostgresMigrationRunner,
  persistenceMigrations,
  withPostgresSqlClient,
  type SqlClient,
  type SqlRow,
} from "../index.js";
import type { LifecycleEvent } from "@repo/platform-protocol/lifecycle";
import { describe, expect, it } from "vitest";

// This suite is intentionally opt-in. Point it only at a disposable clone of
// the local database; all synthetic rows are enclosed in a transaction that
// is rolled back before the connection closes.
const databaseUrl = process.env.LEGIONCODE_TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres("chat durability against PostgreSQL", () => {
  it("reads preserved sessions by owner across opaque sequence pages", async () => {
    await withPostgresSqlClient(requiredDatabaseUrl(), async (client) => {
      await applyPendingMigrations(client);
      const sessions = await client.query<SqlRow & {
        session_id: string;
        user_id: string;
        message_count: string;
        part_count: string;
      }>(`
        SELECT s.id::text AS session_id, s.user_id::text AS user_id,
          COUNT(DISTINCT m.id)::text AS message_count,
          COUNT(p.id)::text AS part_count
        FROM sessions s
        JOIN messages m ON m.session_id = s.id
        JOIN message_parts p ON p.message_id = m.id AND p.session_id = s.id
        GROUP BY s.id, s.user_id
        ORDER BY s.id
      `);

      expect(sessions.rows.length).toBeGreaterThan(0);
      const repository = new PostgresTranscriptRepository(client);
      for (const row of sessions.rows) {
        const before = await repository.listTranscript({
          sessionId: row.session_id,
          userId: row.user_id,
          limit: 37,
        });
        expect(before.sessionFound).toBe(true);
        expect(before.snapshot).toBeGreaterThanOrEqual(0);

        const ids = new Set<string>();
        let cursor: number | null = null;
        let snapshot = before.snapshot;
        let pages = 0;
        do {
          const page = await repository.listTranscript({
            sessionId: row.session_id,
            userId: row.user_id,
            cursor,
            snapshot,
            limit: 37,
          });
          expect(page.sessionFound).toBe(true);
          expect(page.snapshot).toBe(snapshot);
          for (const message of page.messages) {
            expect(ids.has(message.id)).toBe(false);
            ids.add(message.id);
            expect(message.parts.length).toBeGreaterThan(0);
          }
          if (page.nextCursor !== null) {
            expect(page.nextCursor).toBeGreaterThan(cursor ?? 0);
          }
          cursor = page.nextCursor;
          pages += 1;
          expect(pages).toBeLessThan(100);
        } while (cursor !== null);

        // Rows with revision supersession are intentionally hidden by the
        // repository. The raw owner/count query above is metadata-only; this
        // assertion verifies we recovered an actual saved transcript without
        // exposing prompt or response text in test output.
        expect(ids.size).toBeGreaterThan(0);
        expect(ids.size).toBe(Number(row.message_count));
        expect(Number(row.part_count)).toBeGreaterThan(0);
      }
    });
  }, 60_000);

  it("pins a 600-message snapshot and rolls back admission and lifecycle fixtures", async () => {
    await withPostgresSqlClient(requiredDatabaseUrl(), async (client) => {
      await applyPendingMigrations(client);
      const baseline = await readDurabilityCounts(client);
      const rollbackMarker = new Error("rollback chat durability fixture");
      try {
        await client.transaction(async (tx) => {
          const fixture = await createFixture(tx);
          const transcript = new PostgresTranscriptRepository(tx);
          const admissions = new PostgresTurnAdmissionRepository(tx);
          for (let index = 0; index < 600; index += 1) {
            await transcript.appendMessageToExistingSession({
              sessionId: fixture.sessionId,
              role: "user",
              dedupeKey: `page-${index}`,
              clientMessageId: `client-${index}`,
              parts: [{ type: "text", content: { text: `fixture-${index}` } }],
            });
          }

          const first = await transcript.listTranscript({
            sessionId: fixture.sessionId,
            userId: fixture.userId,
            limit: 53,
          });
          expect(first.messages).toHaveLength(53);
          const stableSnapshot = first.snapshot;
          const firstCursor = first.nextCursor;
          expect(firstCursor).not.toBeNull();

          await transcript.appendMessageToExistingSession({
            sessionId: fixture.sessionId,
            role: "user",
            dedupeKey: "after-snapshot",
            clientMessageId: "after-snapshot-client",
            parts: [{ type: "text", content: { text: "post-snapshot" } }],
          });

          const streamingTuple = {
            ...fixture.admission,
            clientMessageId: `client-stream-${randomUUID().replaceAll("-", "")}`,
            turnId: `trn_${randomUUID().replaceAll("-", "")}`,
            runAttemptId: `attempt_${randomUUID().replaceAll("-", "")}`,
            runId: `run_${randomUUID().replaceAll("-", "")}`,
          };
          const streamingAdmission = await admitFixtureTurn(admissions, fixture, streamingTuple, "streaming-item");
          const streamingFixture = { ...fixture, admission: streamingTuple };
          await new PostgresLifecycleEventStore(tx).appendBatch([
            lifecycleTurnStarted(streamingFixture, 1),
            lifecycleItemStarted(streamingFixture, 2),
            lifecycleDelta(streamingFixture, 3, "commentary"),
            { ...lifecycleDelta(streamingFixture, 4, "commentary"), payload: { kind: "assistant_message", phase: "commentary", delta: "second chunk" } } as LifecycleEvent,
          ]);
          expect(streamingAdmission.admission.state).toBe("admitted");

          const recoveredIds = new Set(first.messages.map((message) => message.id));
          let cursor = firstCursor;
          let pageCount = 1;
          while (cursor !== null) {
            const page = await transcript.listTranscript({
              sessionId: fixture.sessionId,
              userId: fixture.userId,
              cursor,
              snapshot: stableSnapshot,
              limit: 53,
            });
            expect(page.snapshot).toBe(stableSnapshot);
            for (const message of page.messages) {
              expect(recoveredIds.has(message.id)).toBe(false);
              recoveredIds.add(message.id);
            }
            if (page.nextCursor !== null) expect(page.nextCursor).toBeGreaterThan(cursor);
            cursor = page.nextCursor;
            pageCount += 1;
            expect(pageCount).toBeLessThan(20);
          }
          expect(recoveredIds.size).toBe(600);

          const fresh = await transcript.listTranscript({
            sessionId: fixture.sessionId,
            userId: fixture.userId,
            limit: 700,
          });
          expect(fresh.snapshot).toBeGreaterThan(stableSnapshot);
          expect(fresh.messages).toHaveLength(603);
          const growingItem = fresh.messages.find((message) => message.role === "assistant");
          expect(growingItem?.parts).toHaveLength(2);
          const stableAssistant = recoveredIds.has(growingItem?.id ?? "");
          expect(stableAssistant).toBe(false);

          const reserved = await admissions.reserve(fixture.admission);
          const duplicate = await admissions.reserve(fixture.admission);
          expect(duplicate).toMatchObject({
            turnId: reserved.turnId,
            runAttemptId: reserved.runAttemptId,
            runId: reserved.runId,
            state: "reserved",
          });

          const admission = await admissions.admitWithPrompt({
            sessionId: fixture.sessionId,
            clientMessageId: fixture.admission.clientMessageId,
            turnId: fixture.admission.turnId,
            runAttemptId: fixture.admission.runAttemptId,
            runId: fixture.admission.runId,
            requestFingerprint: "fingerprint-first-submit",
            userId: fixture.userId,
            workspaceId: fixture.workspaceId,
            taskId: fixture.taskId,
            mode: "build",
            promptMessage: {
              role: "user",
              clientMessageId: fixture.admission.clientMessageId,
              dedupeKey: `prompt-${fixture.admission.clientMessageId}`,
              parts: [{ type: "text", content: { text: "prompt fixture" } }],
            },
          });
          const replayedAdmission = await admissions.admitWithPrompt({
            sessionId: fixture.sessionId,
            clientMessageId: fixture.admission.clientMessageId,
            turnId: fixture.admission.turnId,
            runAttemptId: fixture.admission.runAttemptId,
            runId: fixture.admission.runId,
            requestFingerprint: "fingerprint-first-submit",
            userId: fixture.userId,
            workspaceId: fixture.workspaceId,
            taskId: fixture.taskId,
            mode: "build",
            promptMessage: {
              role: "user",
              clientMessageId: fixture.admission.clientMessageId,
              dedupeKey: `prompt-${fixture.admission.clientMessageId}`,
              parts: [{ type: "text", content: { text: "prompt fixture" } }],
            },
          });
          expect(replayedAdmission.promptMessageId).toBe(admission.promptMessageId);
          expect(replayedAdmission.admission.state).toBe("admitted");

          expect(await admissions.claimExecution({
            turnId: fixture.admission.turnId,
            runAttemptId: fixture.admission.runAttemptId,
            runId: fixture.admission.runId,
            sessionId: fixture.sessionId,
            userId: fixture.userId,
            workspaceId: fixture.workspaceId,
            threadId: fixture.admission.threadId,
            claimId: "claim-primary",
          })).toMatchObject({ status: "claimed" });
          expect(await admissions.claimExecution({
            turnId: fixture.admission.turnId,
            runAttemptId: fixture.admission.runAttemptId,
            runId: fixture.admission.runId,
            sessionId: fixture.sessionId,
            userId: fixture.userId,
            workspaceId: fixture.workspaceId,
            threadId: fixture.admission.threadId,
            claimId: "claim-retry",
          })).toMatchObject({ status: "already_claimed" });

          const wrongOwner = await admissions.claimExecution({
            turnId: fixture.admission.turnId,
            runAttemptId: fixture.admission.runAttemptId,
            runId: fixture.admission.runId,
            sessionId: fixture.sessionId,
            userId: randomUUID(),
            workspaceId: fixture.workspaceId,
            threadId: fixture.admission.threadId,
            claimId: "claim-wrong-owner",
          });
          expect(wrongOwner.status).toBe("conflict");

          const events: LifecycleEvent[] = [
            lifecycleTurnStarted(fixture, 1),
            lifecycleItemStarted(fixture, 2),
          ];
          for (let sequence = 3; sequence <= 1_102; sequence += 1) {
            const phase = sequence === 3 ? "commentary" : "final_answer";
            events.push(lifecycleDelta(fixture, sequence, phase));
          }
          events.push(lifecycleItemCompleted(fixture, 1_103));
          events.push(lifecycleTurnCompleted(fixture, 1_104));
          const lifecycle = new PostgresLifecycleEventStore(tx);
          const countBeforeRejectedBatch = await countTurnEvents(tx, fixture.admission.turnId);
          await expect(lifecycle.appendBatch([
            lifecycleTurnStarted(fixture, 1_103),
            { ...lifecycleTurnStarted(fixture, 1_104), threadId: `thr_wrong_${randomUUID()}` },
          ])).rejects.toThrow();
          expect(await countTurnEvents(tx, fixture.admission.turnId)).toBe(countBeforeRejectedBatch);
          await lifecycle.appendBatch(events);
          const firstReplay = await lifecycle.replay({ turnId: fixture.admission.turnId, afterSequence: 0, limit: 1_000 });
          expect(firstReplay.events).toHaveLength(1_000);
          expect(firstReplay.nextSequence).toBe(1_000);
          const tail = await lifecycle.replay({ turnId: fixture.admission.turnId, afterSequence: firstReplay.nextSequence, limit: 1_000 });
          expect(tail.events).toHaveLength(104);
          expect(tail.nextSequence).toBe(1_104);
          expect(tail.events.at(-1)?.type).toBe("turn.completed");

          const projected = await transcript.listTranscript({
            sessionId: fixture.sessionId,
            userId: fixture.userId,
            limit: 700,
          });
          const assistantItems = projected.messages.filter((message) =>
            message.role === "assistant" &&
            message.parts.some((part) => {
              const content = part.content as {
                metadata?: { canonicalIdentity?: { turnId?: string } };
              };
              return content.metadata?.canonicalIdentity?.turnId === fixture.admission.turnId;
            }),
          );
          expect(assistantItems).toHaveLength(2);
          const phases = assistantItems.map((message) => {
            const content = message.parts[0]?.content as { metadata?: { phase?: string } };
            return content.metadata?.phase;
          });
          expect(new Set(phases)).toEqual(new Set(["commentary", "final_answer"]));

          const nextTuple = {
            ...fixture.admission,
            clientMessageId: `client-next-${randomUUID().replaceAll("-", "")}`,
            turnId: `trn_${randomUUID().replaceAll("-", "")}`,
            runAttemptId: `attempt_${randomUUID().replaceAll("-", "")}`,
            runId: `run_${randomUUID().replaceAll("-", "")}`,
          };
          const nextReservation = await admissions.reserve(nextTuple);
          expect(nextReservation.threadId).toBe(fixture.admission.threadId);
          const nextAdmission = await admissions.admitWithPrompt({
            sessionId: fixture.sessionId,
            clientMessageId: nextTuple.clientMessageId,
            turnId: nextTuple.turnId,
            runAttemptId: nextTuple.runAttemptId,
            runId: nextTuple.runId,
            requestFingerprint: "fingerprint-followup-submit",
            userId: fixture.userId,
            workspaceId: fixture.workspaceId,
            taskId: fixture.taskId,
            mode: "build",
            promptMessage: {
              role: "user",
              clientMessageId: nextTuple.clientMessageId,
              dedupeKey: `prompt-${nextTuple.clientMessageId}`,
              parts: [{ type: "text", content: { text: "followup fixture" } }],
            },
          });
          expect(nextAdmission.admission.threadId).toBe(fixture.admission.threadId);
          const binding = await tx.query<SqlRow & { thread_id: string }>(
            "SELECT thread_id FROM sessions WHERE id = $1",
            [fixture.sessionId],
          );
          expect(binding.rows[0]?.thread_id).toBe(fixture.admission.threadId);

          throw rollbackMarker;
        });
      } catch (error) {
        if (error !== rollbackMarker) throw error;
      }
      expect(await readDurabilityCounts(client)).toEqual(baseline);
    });
  }, 60_000);

  it("rolls back lifecycle events when canonical transcript projection fails", async () => {
    await withPostgresSqlClient(requiredDatabaseUrl(), async (client) => {
      await applyPendingMigrations(client);
      const rollbackMarker = new Error("rollback projection failure fixture");
      try {
        await client.transaction(async (tx) => {
          const fixture = await createFixture(tx);
          const admissions = new PostgresTurnAdmissionRepository(tx);
          await admitFixtureTurn(admissions, fixture, fixture.admission, "projection-failure");
          const before = await readSessionSequence(tx, fixture.sessionId);
          await tx.query(`
            CREATE FUNCTION fail_canonical_assistant_projection() RETURNS trigger
            LANGUAGE plpgsql AS $$
            BEGIN
              IF NEW.canonical_turn_id IS NOT NULL THEN
                RAISE EXCEPTION 'injected canonical projection failure';
              END IF;
              RETURN NEW;
            END;
            $$
          `);
          await tx.query(`
            CREATE TRIGGER fail_canonical_assistant_projection_trigger
            BEFORE INSERT ON messages FOR EACH ROW
            EXECUTE FUNCTION fail_canonical_assistant_projection()
          `);

          const events = [
            lifecycleTurnStarted(fixture, 1),
            lifecycleItemStarted(fixture, 2),
            lifecycleDelta(fixture, 3, "final_answer"),
          ];
          const lifecycle = new PostgresLifecycleEventStore(tx);
          await expect(lifecycle.appendBatch(events)).rejects.toThrow("injected canonical projection failure");
          expect(await countTurnEvents(tx, fixture.admission.turnId)).toBe(0);
          expect(await readSessionSequence(tx, fixture.sessionId)).toBe(before);
          const projectedBeforeRetry = await tx.query<SqlRow & { count: string }>(
            "SELECT COUNT(*)::text AS count FROM messages WHERE session_id = $1 AND canonical_turn_id = $2",
            [fixture.sessionId, fixture.admission.turnId],
          );
          expect(Number(projectedBeforeRetry.rows[0]?.count ?? 0)).toBe(0);

          await tx.query("DROP TRIGGER fail_canonical_assistant_projection_trigger ON messages");
          await tx.query("DROP FUNCTION fail_canonical_assistant_projection()");
          await lifecycle.appendBatch(events);
          expect(await countTurnEvents(tx, fixture.admission.turnId)).toBe(3);
          expect(await readSessionSequence(tx, fixture.sessionId)).toBeGreaterThan(before);
          const projectedAfterRetry = await tx.query<SqlRow & { count: string }>(
            "SELECT COUNT(*)::text AS count FROM messages WHERE session_id = $1 AND canonical_turn_id = $2",
            [fixture.sessionId, fixture.admission.turnId],
          );
          expect(Number(projectedAfterRetry.rows[0]?.count ?? 0)).toBe(1);

          throw rollbackMarker;
        });
      } catch (error) {
        if (error !== rollbackMarker) throw error;
      }
    });
  }, 60_000);

  it("recovers snapshot-scoped revision membership when imported prompt parts lack identity metadata", async () => {
    await withPostgresSqlClient(requiredDatabaseUrl(), async (client) => {
      await applyPendingMigrations(client);
      const rollbackMarker = new Error("rollback imported revision fixture");
      try {
        await client.transaction(async (tx) => {
          const fixture = await createFixture(tx);
          const admissions = new PostgresTurnAdmissionRepository(tx);
          await admitFixtureTurn(admissions, fixture, fixture.admission, "legacy-base");
          const lifecycle = new PostgresLifecycleEventStore(tx);
          await lifecycle.appendBatch([
            lifecycleTurnStarted(fixture, 1),
            lifecycleItemStarted(fixture, 2),
            lifecycleDelta(fixture, 3, "final_answer"),
            lifecycleItemCompleted(fixture, 4),
            lifecycleTurnCompleted(fixture, 5),
          ]);

          const original = await tx.query<SqlRow & { message_id: string }>(
            "SELECT id AS message_id FROM messages WHERE session_id = $1 AND client_message_id = $2",
            [fixture.sessionId, fixture.admission.clientMessageId],
          );
          const originalMessageId = original.rows[0]?.message_id;
          expect(originalMessageId).toBeTruthy();
          await tx.query(
            `UPDATE message_parts
             SET content_json = jsonb_build_object('text', content_json ->> 'text')
             WHERE session_id = $1 AND message_id = $2`,
            [fixture.sessionId, originalMessageId],
          );
          const originalAssistant = await tx.query<SqlRow & { message_id: string }>(
            "SELECT id AS message_id FROM messages WHERE session_id = $1 AND canonical_turn_id = $2 AND role = 'assistant'",
            [fixture.sessionId, fixture.admission.turnId],
          );
          await tx.query(
            `UPDATE message_parts
             SET content_json = jsonb_build_object('text', content_json ->> 'text')
             WHERE session_id = $1 AND message_id = $2`,
            [fixture.sessionId, originalAssistant.rows[0]?.message_id],
          );

          const transcript = new PostgresTranscriptRepository(tx);
          const historicalFirst = await transcript.listTranscript({
            sessionId: fixture.sessionId,
            userId: fixture.userId,
            limit: 1,
          });
          const historicalSecond = await transcript.listTranscript({
            sessionId: fixture.sessionId,
            userId: fixture.userId,
            cursor: historicalFirst.nextCursor,
            snapshot: historicalFirst.snapshot,
            limit: 1,
          });
          expect(historicalFirst.supersededTurnIds).toEqual([]);
          expect(historicalSecond.supersededTurnIds).toEqual([]);
          expect(historicalFirst.messages[0]?.role).toBe("user");
          expect(historicalSecond.messages[0]?.role).toBe("assistant");

          const revision = {
            ...fixture.admission,
            clientMessageId: `client-revision-${randomUUID().replaceAll("-", "")}`,
            turnId: `trn_${randomUUID().replaceAll("-", "")}`,
            runAttemptId: `attempt_${randomUUID().replaceAll("-", "")}`,
            runId: `run_${randomUUID().replaceAll("-", "")}`,
            revisionOfTurnId: fixture.admission.turnId,
          };
          await admitFixtureTurn(admissions, fixture, revision, "legacy-revision");
          const revisionMessage = await tx.query<SqlRow & { message_id: string }>(
            "SELECT id AS message_id FROM messages WHERE session_id = $1 AND client_message_id = $2",
            [fixture.sessionId, revision.clientMessageId],
          );
          await tx.query(
            `UPDATE message_parts
             SET content_json = jsonb_build_object('text', content_json ->> 'text')
             WHERE session_id = $1 AND message_id = $2`,
            [fixture.sessionId, revisionMessage.rows[0]?.message_id],
          );

          const first = await transcript.listTranscript({
            sessionId: fixture.sessionId,
            userId: fixture.userId,
            limit: 1,
          });
          expect(first.messages).toHaveLength(1);
          expect(first.nextCursor).not.toBeNull();
          expect(first.supersededTurnIds).toContain(fixture.admission.turnId);
          const originalPart = first.messages[0]?.parts[0]?.content as {
            text?: string;
            metadata?: { canonicalIdentity?: { turnId?: string } };
          };
          expect(originalPart.text).toBe("prompt-legacy-base");
          expect(originalPart.metadata?.canonicalIdentity?.turnId).toBe(fixture.admission.turnId);

          const second = await transcript.listTranscript({
            sessionId: fixture.sessionId,
            userId: fixture.userId,
            cursor: first.nextCursor,
            snapshot: first.snapshot,
            limit: 1,
          });
          expect(second.snapshot).toBe(first.snapshot);
          expect(second.messages).toHaveLength(1);
          expect(second.messages[0]?.role).toBe("assistant");
          const assistantPart = second.messages[0]?.parts[0]?.content as {
            text?: string;
            metadata?: { canonicalIdentity?: { threadId?: string; turnId?: string } };
          };
          expect(assistantPart.text).toBe("x");
          expect(assistantPart.metadata?.canonicalIdentity).toMatchObject({
            threadId: fixture.admission.threadId,
            turnId: fixture.admission.turnId,
          });
          expect(second.supersededTurnIds).toContain(fixture.admission.turnId);

          const latestThird = await transcript.listTranscript({
            sessionId: fixture.sessionId,
            userId: fixture.userId,
            cursor: second.nextCursor,
            snapshot: first.snapshot,
            limit: 1,
          });
          expect(latestThird.snapshot).toBe(first.snapshot);
          expect(latestThird.messages[0]?.clientMessageId).toBe(revision.clientMessageId);
          expect(latestThird.supersededTurnIds).toContain(fixture.admission.turnId);

          // Context assembly receives this same snapshot-wide superseded set;
          // the legacy original prompt and assistant reply are excluded by
          // their projected identities, while the earlier snapshot remains
          // on the original branch.
          const newestMessages = [...first.messages, ...second.messages, ...latestThird.messages];
          const visibleTurnIds = newestMessages
            .map((message) => {
              const content = message.parts[0]?.content as { metadata?: { canonicalIdentity?: { turnId?: string } } };
              return content.metadata?.canonicalIdentity?.turnId;
            })
            .filter((turnId): turnId is string => typeof turnId === "string");
          expect(visibleTurnIds.filter((turnId) => !first.supersededTurnIds.includes(turnId))).toEqual([
            revision.turnId,
          ]);
          const historicalRereadFirst = await transcript.listTranscript({
            sessionId: fixture.sessionId,
            userId: fixture.userId,
            limit: 1,
            snapshot: historicalFirst.snapshot,
          });
          const historicalRereadSecond = await transcript.listTranscript({
            sessionId: fixture.sessionId,
            userId: fixture.userId,
            cursor: historicalRereadFirst.nextCursor,
            snapshot: historicalFirst.snapshot,
            limit: 1,
          });
          expect(historicalRereadFirst.snapshot).toBe(historicalFirst.snapshot);
          expect(historicalRereadSecond.snapshot).toBe(historicalFirst.snapshot);
          expect(historicalRereadFirst.supersededTurnIds).toEqual([]);
          expect(historicalRereadSecond.supersededTurnIds).toEqual([]);
          expect(historicalRereadFirst.messages[0]?.id).toBe(historicalFirst.messages[0]?.id);
          expect(historicalRereadSecond.messages[0]?.id).toBe(historicalSecond.messages[0]?.id);
          const storedOriginalParts = await tx.query<SqlRow & { content_json: { text?: string; metadata?: unknown } }>(
            `SELECT content_json FROM message_parts
             WHERE session_id = $1 AND message_id = ANY($2::uuid[])
             ORDER BY session_sequence`,
            [fixture.sessionId, [originalMessageId, originalAssistant.rows[0]?.message_id, revisionMessage.rows[0]?.message_id]],
          );
          expect(storedOriginalParts.rows.map((row) => row.content_json)).toEqual([
            { text: "prompt-legacy-base" },
            { text: "x" },
            { text: "prompt-legacy-revision" },
          ]);

          throw rollbackMarker;
        });
      } catch (error) {
        if (error !== rollbackMarker) throw error;
      }
    });
  }, 60_000);

  it("does not let a replayed older terminal overwrite a settled newer turn on the same run", async () => {
    await withPostgresSqlClient(requiredDatabaseUrl(), async (client) => {
      await applyPendingMigrations(client);
      const rollbackMarker = new Error("rollback terminal replay fixture");
      try {
        await client.transaction(async (tx) => {
          const fixture = await createFixture(tx);
          const admissions = new PostgresTurnAdmissionRepository(tx);
          await admitFixtureTurn(admissions, fixture, fixture.admission, "old-turn");
          const oldTerminal = lifecycleTurnFailed(fixture, 4);
          const lifecycle = new PostgresLifecycleEventStore(tx);
          await lifecycle.appendBatch([
            lifecycleTurnStarted(fixture, 1),
            lifecycleItemStarted(fixture, 2),
            lifecycleItemCompleted(fixture, 3),
            oldTerminal,
          ]);

          const newer = {
            ...fixture.admission,
            clientMessageId: `client-new-${randomUUID().replaceAll("-", "")}`,
            turnId: `trn_${randomUUID().replaceAll("-", "")}`,
            runAttemptId: `attempt_${randomUUID().replaceAll("-", "")}`,
          };
          await admissions.reserve(newer);
          await admitFixtureTurn(admissions, fixture, newer, "new-turn");
          const newerFixture = { ...fixture, admission: newer };
          await lifecycle.appendBatch([
            lifecycleTurnStarted(newerFixture, 1),
            lifecycleItemStarted(newerFixture, 2),
            lifecycleItemCompleted(newerFixture, 3),
            lifecycleTurnCompleted(newerFixture, 4),
          ]);
          const currentBeforeRetry = await readRunStatus(tx, newer.runId);
          expect(currentBeforeRetry).toBe("completed");

          await lifecycle.append(oldTerminal);
          expect(await readRunStatus(tx, newer.runId)).toBe("completed");

          throw rollbackMarker;
        });
      } catch (error) {
        if (error !== rollbackMarker) throw error;
      }
    });
  }, 60_000);

  it("rolls back run and prompt admission when prompt-part persistence fails, then retries cleanly", async () => {
    await withPostgresSqlClient(requiredDatabaseUrl(), async (client) => {
      await applyPendingMigrations(client);
      const rollbackMarker = new Error("rollback admission failure fixture");
      try {
        await client.transaction(async (tx) => {
          const fixture = await createFixture(tx);
          const admissions = new PostgresTurnAdmissionRepository(tx);
          await admissions.reserve(fixture.admission);
          const beforeSequence = await readSessionSequence(tx, fixture.sessionId);
          await tx.query(`
            CREATE FUNCTION fail_admitted_prompt_part() RETURNS trigger
            LANGUAGE plpgsql AS $$
            BEGIN
              IF NEW.content_json #>> '{text}' = 'prompt-atomic-failure' THEN
                RAISE EXCEPTION 'injected prompt persistence failure';
              END IF;
              RETURN NEW;
            END;
            $$
          `);
          await tx.query(`
            CREATE TRIGGER fail_admitted_prompt_part_trigger
            BEFORE INSERT ON message_parts FOR EACH ROW
            EXECUTE FUNCTION fail_admitted_prompt_part()
          `);

          const failedInput = admissionInput(fixture, fixture.admission, "atomic-failure");
          failedInput.promptMessage.parts = [
            { type: "text", content: { text: "prompt-atomic-failure" } },
          ];
          await expect(admissions.admitWithPrompt(failedInput)).rejects.toThrow("injected prompt persistence failure");
          expect(await readRunStatus(tx, fixture.admission.runId)).toBeNull();
          expect(await readSessionSequence(tx, fixture.sessionId)).toBe(beforeSequence);
          const stateAfterFailure = await admissions.getByTurnId(fixture.admission.turnId);
          expect(stateAfterFailure?.state).toBe("reserved");
          const sessionAfterFailure = await tx.query<SqlRow & { status: string; active_run_id: string | null }>(
            "SELECT status, active_run_id FROM sessions WHERE id = $1",
            [fixture.sessionId],
          );
          expect(sessionAfterFailure.rows[0]).toMatchObject({ status: "idle", active_run_id: null });

          await tx.query("DROP TRIGGER fail_admitted_prompt_part_trigger ON message_parts");
          await tx.query("DROP FUNCTION fail_admitted_prompt_part()");
          const retried = await admissions.admitWithPrompt(admissionInput(fixture, fixture.admission, "atomic-failure"));
          expect(retried.admission.state).toBe("admitted");
          expect(await readRunStatus(tx, fixture.admission.runId)).toBe("running");
          expect(await admissions.getByTurnId(fixture.admission.turnId)).toMatchObject({
            state: "admitted",
            executionState: "pending",
          });

          throw rollbackMarker;
        });
      } catch (error) {
        if (error !== rollbackMarker) throw error;
      }
    });
  }, 60_000);

  it("binds a legacy null session workspace only from its owned task and validates task association", async () => {
    await withPostgresSqlClient(requiredDatabaseUrl(), async (client) => {
      await applyPendingMigrations(client);
      const rollbackMarker = new Error("rollback task workspace binding fixture");
      try {
        await client.transaction(async (tx) => {
          const fixture = await createFixture(tx);
          const admissions = new PostgresTurnAdmissionRepository(tx);
          await tx.query("UPDATE sessions SET workspace_id = NULL WHERE id = $1", [fixture.sessionId]);
          const wrongWorkspace = randomUUID();
          await expect(
            admissions.reserve({
              ...fixture.admission,
              workspaceId: wrongWorkspace,
            }),
          ).rejects.toMatchObject({ code: "workspace_conflict" });
          let binding = await readSessionBinding(tx, fixture.sessionId);
          expect(binding).toEqual({ threadId: null, workspaceId: null });
          expect(await admissions.getBySessionAndClientMessage(fixture.sessionId, fixture.admission.clientMessageId)).toBeNull();

          const otherOwner = randomUUID();
          await tx.query("INSERT INTO users (id, display_name) VALUES ($1, $2)", [otherOwner, "foreign-task-owner"]);
          await tx.query("UPDATE tasks SET user_id = $2 WHERE id = $1", [fixture.taskId, otherOwner]);
          await expect(admissions.reserve(fixture.admission)).rejects.toMatchObject({ code: "task_scope_conflict" });
          binding = await readSessionBinding(tx, fixture.sessionId);
          expect(binding).toEqual({ threadId: null, workspaceId: null });

          await tx.query("UPDATE tasks SET user_id = $2 WHERE id = $1", [fixture.taskId, fixture.userId]);
          const reserved = await admissions.reserve(fixture.admission);
          expect(reserved.workspaceId).toBe(fixture.workspaceId);
          expect(reserved.threadId).toBe(fixture.admission.threadId);
          const repeated = await admissions.reserve(fixture.admission);
          expect(repeated).toMatchObject({
            threadId: reserved.threadId,
            workspaceId: fixture.workspaceId,
            turnId: reserved.turnId,
          });
          binding = await readSessionBinding(tx, fixture.sessionId);
          expect(binding).toEqual({ threadId: fixture.admission.threadId, workspaceId: fixture.workspaceId });

          await expect(
            admissions.admitWithPrompt({
              ...admissionInput(fixture, fixture.admission, "wrong-task"),
              taskId: randomUUID(),
            }),
          ).rejects.toMatchObject({ code: "task_scope_conflict" });
          expect(await readRunStatus(tx, fixture.admission.runId)).toBeNull();

          const admitted = await admissions.admitWithPrompt(admissionInput(fixture, fixture.admission, "correct-task"));
          expect(admitted.admission.state).toBe("admitted");
          throw rollbackMarker;
        });
      } catch (error) {
        if (error !== rollbackMarker) throw error;
      }
    });
  }, 60_000);

  it("serializes competing revisions of the same terminal turn across connections", async () => {
    await withPostgresSqlClient(requiredDatabaseUrl(), async (setup) => {
      await applyPendingMigrations(setup);
      const fixture = await createFixture(setup);
      try {
      const admissions = new PostgresTurnAdmissionRepository(setup);
      await admitFixtureTurn(admissions, fixture, fixture.admission, "revision-base");
      const lifecycle = new PostgresLifecycleEventStore(setup);
      await lifecycle.appendBatch([
        lifecycleTurnStarted(fixture, 1),
        lifecycleItemStarted(fixture, 2),
        lifecycleItemCompleted(fixture, 3),
        lifecycleTurnCompleted(fixture, 4),
      ]);

      const candidate = (label: string) => ({
        ...fixture.admission,
        clientMessageId: `client-${label}-${randomUUID().replaceAll("-", "")}`,
        turnId: `trn_${randomUUID().replaceAll("-", "")}`,
        runAttemptId: `attempt_${randomUUID().replaceAll("-", "")}`,
        runId: `run_${randomUUID().replaceAll("-", "")}`,
        revisionOfTurnId: fixture.admission.turnId,
      });
      const left = candidate("left");
      const right = candidate("right");
      await admissions.reserve(left);
      await admissions.reserve(right);

      const outcomes = await Promise.all([
        withPostgresSqlClient(requiredDatabaseUrl(), (connection) =>
          new PostgresTurnAdmissionRepository(connection).admitWithPrompt(admissionInput(fixture, left, "concurrent-left")),
        ).then(() => "admitted", (error: unknown) => isRevisionConflict(error) ? "conflict" : Promise.reject(error)),
        withPostgresSqlClient(requiredDatabaseUrl(), (connection) =>
          new PostgresTurnAdmissionRepository(connection).admitWithPrompt(admissionInput(fixture, right, "concurrent-right")),
        ).then(() => "admitted", (error: unknown) => isRevisionConflict(error) ? "conflict" : Promise.reject(error)),
      ]);
      expect(outcomes.filter((outcome) => outcome === "admitted")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome === "conflict")).toHaveLength(1);

      } finally {
        await cleanupFixture(setup, fixture);
      }
    });
  }, 60_000);
});

function requiredDatabaseUrl(): string {
  if (!databaseUrl) throw new Error("Set LEGIONCODE_TEST_DATABASE_URL to an isolated database clone");
  return databaseUrl;
}

async function applyPendingMigrations(client: SqlClient): Promise<void> {
  await new PostgresMigrationRunner(client, new PostgresMigrationLedger()).runPending(
    persistenceMigrations,
  );
}

async function countTurnEvents(client: SqlClient, turnId: string): Promise<number> {
  const result = await client.query<SqlRow & { count: string }>(
    "SELECT COUNT(*)::text AS count FROM canonical_lifecycle_events WHERE turn_id = $1",
    [turnId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function readSessionSequence(client: SqlClient, sessionId: string): Promise<number> {
  const result = await client.query<SqlRow & { last_sequence: string | number }>(
    "SELECT last_sequence FROM sessions WHERE id = $1",
    [sessionId],
  );
  return Number(result.rows[0]?.last_sequence ?? -1);
}

async function readRunStatus(client: SqlClient, runId: string): Promise<string | null> {
  const result = await client.query<SqlRow & { status: string }>(
    "SELECT status FROM runs WHERE id = $1",
    [runId],
  );
  return result.rows[0]?.status ?? null;
}

async function readSessionBinding(
  client: SqlClient,
  sessionId: string,
): Promise<{ threadId: string | null; workspaceId: string | null }> {
  const result = await client.query<SqlRow & { thread_id: string | null; workspace_id: string | null }>(
    "SELECT thread_id, workspace_id FROM sessions WHERE id = $1",
    [sessionId],
  );
  return {
    threadId: result.rows[0]?.thread_id ?? null,
    workspaceId: result.rows[0]?.workspace_id ?? null,
  };
}

function admissionInput(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  admission: typeof fixture.admission,
  label: string,
) {
  return {
    sessionId: fixture.sessionId,
    clientMessageId: admission.clientMessageId,
    turnId: admission.turnId,
    runAttemptId: admission.runAttemptId,
    runId: admission.runId,
    requestFingerprint: `fingerprint-${label}`,
    userId: fixture.userId,
    workspaceId: fixture.workspaceId,
    taskId: fixture.taskId,
    mode: "build",
    promptMessage: {
      role: "user" as const,
      clientMessageId: admission.clientMessageId,
      dedupeKey: `prompt-${label}`,
      parts: [{ type: "text" as const, content: { text: `prompt-${label}` } }],
    },
  };
}

async function admitFixtureTurn(
  admissions: PostgresTurnAdmissionRepository,
  fixture: Awaited<ReturnType<typeof createFixture>>,
  admission: typeof fixture.admission,
  label: string,
) {
  await admissions.reserve(admission);
  return await admissions.admitWithPrompt(admissionInput(fixture, admission, label));
}

function isRevisionConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && (error as { code?: unknown }).code === "revision_target_not_current";
}

async function cleanupFixture(client: SqlClient, fixture: Awaited<ReturnType<typeof createFixture>>): Promise<void> {
  const turnIds = await client.query<SqlRow & { turn_id: string }>(
    "SELECT turn_id FROM canonical_turn_admissions WHERE session_id = $1",
    [fixture.sessionId],
  );
  const ids = turnIds.rows.map((row) => row.turn_id);
  if (ids.length) {
    await client.query("DELETE FROM canonical_lifecycle_projections WHERE turn_id = ANY($1::text[])", [ids]);
    await client.query("DELETE FROM canonical_lifecycle_events WHERE turn_id = ANY($1::text[])", [ids]);
  }
  await client.query("DELETE FROM canonical_turn_admissions WHERE session_id = $1", [fixture.sessionId]);
  await client.query("DELETE FROM message_parts WHERE session_id = $1", [fixture.sessionId]);
  await client.query("DELETE FROM messages WHERE session_id = $1", [fixture.sessionId]);
  await client.query("DELETE FROM runs WHERE session_id = $1", [fixture.sessionId]);
  await client.query("DELETE FROM sessions WHERE id = $1", [fixture.sessionId]);
  await client.query("DELETE FROM workspaces WHERE id = $1", [fixture.workspaceId]);
  await client.query("DELETE FROM repos WHERE owner = 'codex' AND name = $1", [fixture.repoName]);
  await client.query("DELETE FROM users WHERE id = $1", [fixture.userId]);
}

async function readDurabilityCounts(client: SqlClient): Promise<{ users: number; sessions: number; messages: number; parts: number; events: number }> {
  const result = await client.query<SqlRow & { users: string; sessions: string; messages: string; parts: string; events: string }>(`
    SELECT
      (SELECT COUNT(*) FROM users)::text AS users,
      (SELECT COUNT(*) FROM sessions)::text AS sessions,
      (SELECT COUNT(*) FROM messages)::text AS messages,
      (SELECT COUNT(*) FROM message_parts)::text AS parts,
      (SELECT COUNT(*) FROM canonical_lifecycle_events)::text AS events
  `);
  const row = result.rows[0];
  if (!row) throw new Error("Unable to read baseline persistence counts");
  return {
    users: Number(row.users),
    sessions: Number(row.sessions),
    messages: Number(row.messages),
    parts: Number(row.parts),
    events: Number(row.events),
  };
}

async function createFixture(client: SqlClient) {
  const suffix = randomUUID().replaceAll("-", "");
  const userId = randomUUID();
  const repoId = randomUUID();
  const workspaceId = randomUUID();
  const taskId = randomUUID();
  const sessionId = randomUUID();
  const runId = `run_${suffix}`;
  const threadId = `thr_${suffix}`;
  const turnId = `trn_${suffix}`;
  const runAttemptId = `attempt_${suffix}`;
  const clientMessageId = `client-${suffix}`;

  await client.query("INSERT INTO users (id, display_name) VALUES ($1, $2)", [userId, "durability-test"]);
  await client.query(
    "INSERT INTO repos (id, provider, owner, name, full_name, repo_url, default_branch) VALUES ($1, 'test', 'codex', $2, $3, 'https://invalid.test/repo', 'main')",
    [repoId, `repo-${suffix}`, `codex/repo-${suffix}`],
  );
  await client.query(
    "INSERT INTO workspaces (id, user_id, repo_id, name, default_branch, last_selected_branch) VALUES ($1, $2, $3, $4, 'main', 'main')",
    [workspaceId, userId, repoId, `workspace-${suffix}`],
  );
  await new PostgresTranscriptRepository(client).ensureSession({
    sessionId,
    userId,
    workspaceId,
    taskId,
    title: "durability fixture",
    threadId: null,
    activeRunId: null,
    status: "idle",
  });
  return {
    userId,
    repoName: `repo-${suffix}`,
    workspaceId,
    taskId,
    sessionId,
    admission: {
      sessionId,
      userId,
      workspaceId,
      clientMessageId,
      threadId,
      turnId,
      runAttemptId,
      runId,
    },
  };
}

function lifecycleDelta(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  sequence: number,
  phase: "commentary" | "final_answer",
): LifecycleEvent {
  const suffix = randomUUID().replaceAll("-", "");
  return {
    eventId: `evt_${suffix}`,
    threadId: fixture.admission.threadId,
    turnId: fixture.admission.turnId,
    runAttemptId: fixture.admission.runAttemptId,
    itemId: `itm_${fixture.admission.turnId.slice(4)}`,
    sequence,
    idempotencyKey: `durability-fixture:${sequence}`,
    producer: { kind: "runtime_kernel", id: "chat-durability-postgres-test" },
    schemaVersion: 1,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence % 60)).toISOString(),
    type: "assistant_message.delta",
    payload: { kind: "assistant_message", phase, delta: "x" },
  } as LifecycleEvent;
}

function lifecycleItemStarted(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  sequence: number,
): LifecycleEvent {
  return {
    ...lifecycleEnvelope(fixture, sequence),
    itemId: `itm_${fixture.admission.turnId.slice(4)}`,
    type: "item.started",
    payload: { kind: "assistant_message" },
  } as LifecycleEvent;
}

function lifecycleItemCompleted(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  sequence: number,
): LifecycleEvent {
  return {
    ...lifecycleEnvelope(fixture, sequence),
    itemId: `itm_${fixture.admission.turnId.slice(4)}`,
    type: "item.completed",
    payload: { result: {} },
  } as LifecycleEvent;
}

function lifecycleEnvelope(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  sequence: number,
) {
  return {
    eventId: `evt_${randomUUID().replaceAll("-", "")}`,
    threadId: fixture.admission.threadId,
    turnId: fixture.admission.turnId,
    runAttemptId: fixture.admission.runAttemptId,
    sequence,
    idempotencyKey: `durability-fixture:${sequence}`,
    producer: { kind: "runtime_kernel", id: "chat-durability-postgres-test" },
    schemaVersion: 1,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence % 60)).toISOString(),
  };
}

function lifecycleTurnStarted(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  sequence: number,
): LifecycleEvent {
  const suffix = randomUUID().replaceAll("-", "");
  return {
    eventId: `evt_${suffix}`,
    threadId: fixture.admission.threadId,
    turnId: fixture.admission.turnId,
    runAttemptId: fixture.admission.runAttemptId,
    sequence,
    idempotencyKey: `durability-fixture:${sequence}`,
    producer: { kind: "runtime_kernel", id: "chat-durability-postgres-test" },
    schemaVersion: 1,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
    type: "turn.started",
    payload: {},
  } as LifecycleEvent;
}

function lifecycleTurnCompleted(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  sequence: number,
): LifecycleEvent {
  const suffix = randomUUID().replaceAll("-", "");
  return {
    eventId: `evt_${suffix}`,
    threadId: fixture.admission.threadId,
    turnId: fixture.admission.turnId,
    runAttemptId: fixture.admission.runAttemptId,
    sequence,
    idempotencyKey: `durability-fixture:${sequence}`,
    producer: { kind: "runtime_kernel", id: "chat-durability-postgres-test" },
    schemaVersion: 1,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
    type: "turn.completed",
    payload: { outcome: { status: "completed" } },
  } as LifecycleEvent;
}

function lifecycleTurnFailed(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  sequence: number,
): LifecycleEvent {
  return {
    eventId: `evt_${randomUUID().replaceAll("-", "")}`,
    threadId: fixture.admission.threadId,
    turnId: fixture.admission.turnId,
    runAttemptId: fixture.admission.runAttemptId,
    sequence,
    idempotencyKey: `durability-fixture:failed:${sequence}`,
    producer: { kind: "runtime_kernel", id: "chat-durability-postgres-test" },
    schemaVersion: 1,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
    type: "turn.failed",
    payload: {
      outcome: {
        status: "failed",
        failure: {
          code: "internal_error",
          message: "synthetic failure",
          retryable: false,
          correlationId: null,
          details: null,
        },
      },
    },
  } as LifecycleEvent;
}
