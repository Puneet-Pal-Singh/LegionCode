import { encryptToken } from "@legioncode/github-bridge";
import { createAppServerClient, createAppServerHttpTransport } from "@legioncode/sdk";
import { MemoryTranscriptRepository, SessionReadReceiptError, type SessionReadReceiptRepository } from "@repo/persistence";
import { TurnIdSchema } from "@repo/platform-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppServerController } from "../../controllers/AppServerController";
import type { Env } from "../../types/ai";

const USER = "550e8400-e29b-41d4-a716-446655440001";
const OTHER_USER = "550e8400-e29b-41d4-a716-446655440002";
const SESSION = "550e8400-e29b-41d4-a716-446655440011";
const FIRST_TURN = TurnIdSchema.parse("trn_receiptfirst1");
const SECOND_TURN = TurnIdSchema.parse("trn_receiptsecond1");

describe("authenticated hosted session read receipts", () => {
  afterEach(() => vi.restoreAllMocks());

  it("round-trips viewer read state through list, acknowledgement, archived list and reload", async () => {
    const transcripts = new MemoryTranscriptRepository();
    await transcripts.ensureSession({
      sessionId: SESSION, userId: USER, taskId: SESSION, threadId: "thr_receiptthread1",
      title: "Receipt fixture", status: "completed",
    });
    let latestTerminalTurnId = FIRST_TURN;
    let receipt: Awaited<ReturnType<SessionReadReceiptRepository["acknowledge"]>> | null = null;
    const readReceipts: SessionReadReceiptRepository = {
      listReadStates: async (viewerId, sessionIds) => sessionIds.includes(SESSION) && viewerId === USER ? [{
        sessionId: SESSION,
        lastTerminalTurnId: latestTerminalTurnId,
        lastAcknowledgedTerminalTurnId: receipt?.lastAcknowledgedTerminalTurnId ?? null,
        acknowledgedAt: receipt?.acknowledgedAt ?? null,
      }] : [],
      acknowledge: async (input) => {
        if (input.sessionId !== SESSION || input.viewerId !== USER) throw new SessionReadReceiptError("session_not_found", "Session not found");
        if (input.terminalTurnId !== latestTerminalTurnId) throw new SessionReadReceiptError("stale_terminal_turn", "Acknowledgement does not match the latest terminal turn");
        if (receipt?.lastAcknowledgedTerminalTurnId === input.terminalTurnId) return receipt;
        receipt = {
          sessionId: input.sessionId,
          viewerId: input.viewerId,
          lastAcknowledgedTerminalTurnId: input.terminalTurnId,
          acknowledgedAt: input.acknowledgedAt,
        };
        return receipt;
      },
    };
    const client = await createClient(await createEnv(transcripts, readReceipts, USER));

    expect(await client.listSessions()).toMatchObject([{ id: SESSION, lastTerminalTurnId: FIRST_TURN, lastAcknowledgedTerminalTurnId: null }]);
    const acknowledged = await client.acknowledgeSessionReadReceipt(SESSION, FIRST_TURN);
    expect(acknowledged).toMatchObject({ sessionId: SESSION, lastAcknowledgedTerminalTurnId: FIRST_TURN });
    expect(await (await createClient(await createEnv(transcripts, readReceipts, USER))).listSessions()).toMatchObject([
      { id: SESSION, lastTerminalTurnId: FIRST_TURN, lastAcknowledgedTerminalTurnId: FIRST_TURN },
    ]);

    await transcripts.archiveSession(USER, SESSION);
    expect(await client.listArchivedSessions()).toMatchObject([
      { id: SESSION, lastTerminalTurnId: FIRST_TURN, lastAcknowledgedTerminalTurnId: FIRST_TURN },
    ]);
    latestTerminalTurnId = SECOND_TURN;
    expect(await client.listArchivedSessions()).toMatchObject([
      { id: SESSION, lastTerminalTurnId: SECOND_TURN, lastAcknowledgedTerminalTurnId: FIRST_TURN },
    ]);
    await expect(client.acknowledgeSessionReadReceipt(SESSION, FIRST_TURN)).rejects.toMatchObject({
      code: "server_error", serverCode: "conflict", method: "session/readReceipt",
    });
    expect(receipt?.lastAcknowledgedTerminalTurnId).toBe(FIRST_TURN);
  });

  it("binds the session list and acknowledgement to the verified cookie viewer", async () => {
    const transcripts = new MemoryTranscriptRepository();
    await transcripts.ensureSession({ sessionId: SESSION, userId: USER, taskId: SESSION, title: "Owner only" });
    const readReceipts: SessionReadReceiptRepository = {
      listReadStates: async (viewerId, sessionIds) => viewerId === USER && sessionIds.includes(SESSION) ? [{
        sessionId: SESSION, lastTerminalTurnId: FIRST_TURN, lastAcknowledgedTerminalTurnId: null, acknowledgedAt: null,
      }] : [],
      acknowledge: async () => { throw new SessionReadReceiptError("session_not_found", "Session not found"); },
    };
    expect(await (await createClient(await createEnv(transcripts, readReceipts, OTHER_USER))).listSessions()).toEqual([]);
    const anonymous = await createClient(await createEnv(transcripts, readReceipts, USER), false);
    await expect(anonymous.listSessions()).rejects.toMatchObject({ code: "server_error", serverCode: "unauthorized" });
    await expect(anonymous.acknowledgeSessionReadReceipt(SESSION, FIRST_TURN)).rejects.toMatchObject({
      code: "server_error", serverCode: "unauthorized",
    });
  });
});

async function createClient(env: Env, authenticated = true) {
  return createAppServerClient({
    clientId: "web-receipts-test", clientVersion: "0.1.0",
    transport: createAppServerHttpTransport({
      baseUrl: "https://brain.local", credentials: "include",
      fetchImpl: async (input, init) => {
        const headers = new Headers(init?.headers);
        if (authenticated) headers.set("Cookie", "legioncode_session=receipt-fixture");
        return await AppServerController.request(new Request(input, { ...init, headers }), env);
      },
    }),
  });
}

async function createEnv(
  transcripts: MemoryTranscriptRepository,
  readReceipts: SessionReadReceiptRepository,
  userId: string,
): Promise<Env> {
  const encryptedToken = await encryptToken("fixture-token", "fixture-encryption-key");
  return {
    AUTH_TRANSCRIPT_REPOSITORY: transcripts,
    AUTH_SESSION_READ_RECEIPT_REPOSITORY: readReceipts,
    AUTH_IDENTITY_REPOSITORY: {
      createGitHubSession: async () => { throw new Error("not used"); },
      findSessionByHash: async () => ({
        authSessionId: SESSION, userId, login: "receipt-test", avatar: "", email: null,
        name: null, githubScopes: [], encryptedToken, createdAt: Date.now(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      findLatestGitHubSessionByUserId: async () => null,
      revokeSession: async () => undefined,
    },
    GITHUB_TOKEN_ENCRYPTION_KEY: "fixture-encryption-key",
  } as Env;
}
