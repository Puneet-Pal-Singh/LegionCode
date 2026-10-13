import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { sessionReadReceiptsMigration } from "../migrations/0033-session-read-receipts.js";

describe("hosted session read receipt migration", () => {
  it("preserves thread receipts and supports exactly one durable owner", async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        CREATE TABLE sessions (id UUID PRIMARY KEY);
        CREATE TABLE canonical_thread_projections (thread_id TEXT PRIMARY KEY);
        CREATE TABLE thread_read_receipts (
          thread_id TEXT NOT NULL,
          viewer_id TEXT NOT NULL,
          last_acknowledged_terminal_turn_id TEXT,
          acknowledged_at TIMESTAMPTZ NOT NULL,
          PRIMARY KEY (thread_id, viewer_id),
          CONSTRAINT thread_read_receipts_thread_fk FOREIGN KEY (thread_id)
            REFERENCES canonical_thread_projections(thread_id) ON DELETE CASCADE
        );
        INSERT INTO canonical_thread_projections VALUES ('thr_legacy01');
        INSERT INTO thread_read_receipts VALUES ('thr_legacy01', 'viewer-legacy', 'trn_legacy01', '2026-10-11T12:00:00Z');
      `);
      for (const statement of sessionReadReceiptsMigration.statements) await db.exec(statement);
      expect((await db.query("SELECT thread_id, session_id, viewer_id, last_acknowledged_terminal_turn_id, acknowledged_at::text FROM thread_read_receipts")).rows[0]).toMatchObject({
        thread_id: "thr_legacy01", session_id: null, viewer_id: "viewer-legacy", last_acknowledged_terminal_turn_id: "trn_legacy01", acknowledged_at: "2026-10-11 12:00:00+00",
      });
      await db.exec("INSERT INTO thread_read_receipts (thread_id, viewer_id, last_acknowledged_terminal_turn_id, acknowledged_at) VALUES ('thr_legacy01', 'viewer-legacy', 'trn_legacy02', now()) ON CONFLICT (thread_id, viewer_id) DO UPDATE SET last_acknowledged_terminal_turn_id = EXCLUDED.last_acknowledged_terminal_turn_id");
      const sessionId = "00000000-0000-4000-8000-000000000001";
      await db.query("INSERT INTO sessions VALUES ($1)", [sessionId]);
      await db.query("INSERT INTO thread_read_receipts (session_id, viewer_id, last_acknowledged_terminal_turn_id, acknowledged_at) VALUES ($1, 'viewer-session', 'trn_session01', now())", [sessionId]);
      await expect(db.query("INSERT INTO thread_read_receipts (viewer_id, last_acknowledged_terminal_turn_id, acknowledged_at) VALUES ('invalid', 'trn_invalid', now())")).rejects.toThrow();
      await expect(db.query("INSERT INTO thread_read_receipts (thread_id, session_id, viewer_id, last_acknowledged_terminal_turn_id, acknowledged_at) VALUES ('thr_legacy01', $1, 'viewer-both', 'trn_invalid', now())", [sessionId])).rejects.toThrow();
      await db.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
      expect((await db.query("SELECT * FROM thread_read_receipts WHERE viewer_id = 'viewer-session'")).rows).toEqual([]);
      expect((await db.query("SELECT last_acknowledged_terminal_turn_id FROM thread_read_receipts WHERE thread_id = 'thr_legacy01' AND viewer_id = 'viewer-legacy'")).rows[0]?.last_acknowledged_terminal_turn_id).toBe("trn_legacy02");
    } finally {
      await db.close();
    }
  });
});
