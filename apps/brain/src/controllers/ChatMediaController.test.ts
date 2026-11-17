import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { CHAT_IMAGE_CHUNK_MAX_BYTES, type ChatImageReadParams } from "@legioncode/app-server/protocol";
import { ChatImageAttachmentRefSchema } from "@repo/shared-types";
import type { Env } from "../types/ai";
import { PNG_BYTES } from "../services/chat/__tests__/ImageFixtures";
import { composeHostedChatMediaReads } from "../integration/app-server/HostedChatMediaReads";

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
            sessions: [{ id: SESSION_ID, workspaceId: "workspace-1" }],
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

    const getOriginal = vi.fn().mockImplementation(async () => originalImageObject());
    const hosted = composeHostedChatMediaReads(new Request("https://brain.local/app-server/request", {
      headers: { "X-Workspace-Id": "workspace-1" },
    }), { EDIT_ARTIFACTS: { get: getOriginal } } as unknown as Env, "user-1");
    const input = hostedImageInput();
    const first = await hosted.readImage({ ...input, limit: 8 });
    const last = await hosted.readImage({ ...input, offset: 8, limit: PNG_BYTES.length });
    const digest = createHash("sha256").update(PNG_BYTES).digest("hex");
    expect(first).toMatchObject({ reference: input.reference, offset: 0, byteLength: 8, nextOffset: 8, sha256: digest });
    expect(last).toMatchObject({ reference: input.reference, offset: 8, byteLength: PNG_BYTES.length - 8, nextOffset: null, sha256: digest });
    expect(Uint8Array.from(Buffer.from(first.dataBase64, "base64"))).toEqual(PNG_BYTES.slice(0, 8));
    expect(Uint8Array.from(Buffer.from(last.dataBase64, "base64"))).toEqual(PNG_BYTES.slice(8));
    expect(getOriginal).toHaveBeenCalledWith(`chat-media/user-1/${SESSION_ID}/${ATTACHMENT_ID}`);
    getOriginal.mockClear();
    await expect(hosted.readImage({ ...input, offset: input.reference.byteSize })).rejects.toMatchObject({ statusCode: 400, code: "invalid_request" });
    await expect(hosted.readImage({ ...input, limit: CHAT_IMAGE_CHUNK_MAX_BYTES + 1 })).rejects.toThrow();
    expect(getOriginal).not.toHaveBeenCalled();
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

    const env = { EDIT_ARTIFACTS: { get } } as unknown as Env;
    const input = hostedImageInput();
    const foreignWorkspace = composeHostedChatMediaReads(new Request("https://brain.local/app-server/request", {
      headers: { "X-Workspace-Id": "workspace-foreign" },
    }), env, "user-1");
    await expect(foreignWorkspace.readImage(input)).rejects.toMatchObject({ statusCode: 404, operationCode: "CHAT_MEDIA_NOT_FOUND" });
    const hosted = composeHostedChatMediaReads(new Request("https://brain.local/app-server/request"), env, "user-1");
    await expect(hosted.readImage({ ...input, sessionId: "123e4567-e89b-42d3-a456-426614174002" }))
      .rejects.toMatchObject({ statusCode: 404, operationCode: "CHAT_MEDIA_NOT_FOUND" });
    expect(get).not.toHaveBeenCalled();
    get.mockResolvedValue(null);
    await expect(hosted.readImage(input)).rejects.toMatchObject({ statusCode: 404, code: "not_found",
      operationCode: "CHAT_MEDIA_NOT_FOUND", retryable: false, metadata: undefined });
  });

  it("requires authentication", async () => {
    authHelpers.getAuthenticatedUserSession.mockResolvedValueOnce(null);

    const response = await ChatMediaController.get(
      request(),
      { EDIT_ARTIFACTS: { get: vi.fn() } } as unknown as Env,
    );

    expect(response.status).toBe(401);
    expect(transcriptHelpers.withTranscriptRepository).not.toHaveBeenCalled();

    let authorized = true;
    transcriptHelpers.withTranscriptRepository.mockImplementation((_env, callback) => callback({
      listSessions: vi.fn().mockImplementation(async () => ({ tasks: [], sessions: authorized ? [{ id: SESSION_ID, workspaceId: "workspace-1" }] : [] })),
      listArchivedSessions: vi.fn().mockResolvedValue([]),
    }));
    let started!: () => void;
    let release!: (bytes: ArrayBuffer) => void;
    let originalSettled = false;
    const reading = new Promise<void>((resolve) => { started = resolve; });
    const held = new Promise<ArrayBuffer>((resolve) => { release = resolve; });
    const get = vi.fn().mockResolvedValue(originalImageObject(async () => {
      started();
      const bytes = await held;
      originalSettled = true;
      return bytes;
    }));
    const hosted = composeHostedChatMediaReads(new Request("https://brain.local/app-server/request", {
      headers: { "X-Workspace-Id": "workspace-1" },
    }), { EDIT_ARTIFACTS: { get } } as unknown as Env, "user-1");
    const operation = hosted.readImage(hostedImageInput());
    const denied = expect(operation).rejects.toMatchObject({ statusCode: 404, operationCode: "CHAT_MEDIA_NOT_FOUND" });
    await reading;
    authorized = false;
    release(PNG_BYTES.slice().buffer);
    await denied;
    expect(originalSettled).toBe(true);
    expect(get).toHaveBeenCalledTimes(1);
  });
});

function request(): Request {
  return new Request(
    `https://brain.local/api/chat/media/${ATTACHMENT_ID}?session=${SESSION_ID}`,
  );
}

function hostedImageInput(): Extract<ChatImageReadParams, { sessionId: string }> {
  return { sessionId: SESSION_ID, offset: 0, reference: ChatImageAttachmentRefSchema.parse({
    type: "image_attachment", attachmentId: ATTACHMENT_ID, name: "screen.png", mediaType: "image/png", byteSize: PNG_BYTES.length,
  }) };
}

function originalImageObject(arrayBuffer: () => Promise<ArrayBuffer> = async () => PNG_BYTES.slice().buffer) {
  return { body: PNG_BYTES.slice(), size: PNG_BYTES.length, httpMetadata: { contentType: "image/png" }, arrayBuffer };
}
