import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types/ai";

const authHelpers = vi.hoisted(() => ({
  getAuthenticatedUserSession: vi.fn(),
}));
const transcriptHelpers = vi.hoisted(() => ({
  withTranscriptRepository: vi.fn(),
}));

vi.mock("../services/AuthService", () => ({
  getAuthenticatedUserSession: authHelpers.getAuthenticatedUserSession,
}));
vi.mock("../services/sessions/TranscriptPersistenceFactory", () => ({
  withTranscriptRepository: transcriptHelpers.withTranscriptRepository,
}));

import { ChatMediaController } from "./ChatMediaController";

const SESSION_ID = "123e4567-e89b-42d3-a456-426614174001";
const ATTACHMENT_ID = "img_1234567890abcdef";

describe("ChatMediaController", () => {
  beforeEach(() => {
    authHelpers.getAuthenticatedUserSession.mockReset();
    transcriptHelpers.withTranscriptRepository.mockReset();
    authHelpers.getAuthenticatedUserSession.mockResolvedValue({
      userId: "user-1",
      session: {},
    });
    transcriptHelpers.withTranscriptRepository.mockImplementation(
      (_env, callback) =>
        callback({
          listSessions: vi.fn().mockResolvedValue({
            tasks: [],
            sessions: [{ id: SESSION_ID }],
          }),
          listArchivedSessions: vi.fn().mockResolvedValue([]),
        }),
    );
  });

  it("serves private image bytes only inside the authenticated session scope", async () => {
    const get = vi.fn().mockResolvedValue({
      body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      size: 4,
      httpMetadata: { contentType: "image/png" },
    });

    const response = await ChatMediaController.get(
      request(),
      { EDIT_ARTIFACTS: { get } } as unknown as Env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=300");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(get).toHaveBeenCalledWith(
      `chat-media/user-1/${SESSION_ID}/${ATTACHMENT_ID}`,
    );
  });

  it("does not disclose an attachment when the session is not owned", async () => {
    transcriptHelpers.withTranscriptRepository.mockImplementationOnce(
      (_env, callback) =>
        callback({
          listSessions: vi.fn().mockResolvedValue({ tasks: [], sessions: [] }),
          listArchivedSessions: vi.fn().mockResolvedValue([]),
        }),
    );
    const get = vi.fn();

    const response = await ChatMediaController.get(
      request(),
      { EDIT_ARTIFACTS: { get } } as unknown as Env,
    );

    expect(response.status).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    authHelpers.getAuthenticatedUserSession.mockResolvedValueOnce(null);

    const response = await ChatMediaController.get(
      request(),
      { EDIT_ARTIFACTS: { get: vi.fn() } } as unknown as Env,
    );

    expect(response.status).toBe(401);
    expect(transcriptHelpers.withTranscriptRepository).not.toHaveBeenCalled();
  });
});

function request(): Request {
  return new Request(
    `https://brain.local/api/chat/media/${ATTACHMENT_ID}?session=${SESSION_ID}`,
  );
}
