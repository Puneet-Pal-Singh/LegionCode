import {
  CodexStdioTransport,
  CodexTransportError,
} from "./transport/CodexStdioTransport.js";
import type { ThreadStartParams } from "./protocol/generated/v2/ThreadStartParams.js";
import type { ThreadResumeParams } from "./protocol/generated/v2/ThreadResumeParams.js";
import type { ThreadReadParams } from "./protocol/generated/v2/ThreadReadParams.js";
import type { TurnStartParams } from "./protocol/generated/v2/TurnStartParams.js";
import type { TurnSteerParams } from "./protocol/generated/v2/TurnSteerParams.js";
import type { TurnInterruptParams } from "./protocol/generated/v2/TurnInterruptParams.js";

/** Native RPC plumbing only; host admission, canonical IDs and commit ACKs stay outside. */
export class CodexNativeSession {
  private externalThreadId: string | null = null;
  private activeTurnId: string | null = null;
  private startSubmitted = false;
  private opening = false;
  private nativeIdle = false;
  private terminalStatus: "completed" | "interrupted" | "failed" | null = null;

  constructor(private readonly transport: CodexStdioTransport) {}

  async open(params: ThreadStartParams): Promise<string> {
    return this.establish("thread/start", params);
  }

  async resume(params: ThreadResumeParams): Promise<string> {
    // Native resume uses only the persisted ID; no provider history/path reconstruction.
    return this.establish("thread/resume", params, params.threadId);
  }

  private async establish(
    method: "thread/start" | "thread/resume",
    params: ThreadStartParams | ThreadResumeParams,
    expectedId?: string,
  ): Promise<string> {
    if (this.externalThreadId !== null || this.opening)
      throw new CodexTransportError("invalid_frame", "rejected");
    // An ambiguous open is not automatically retried on this session owner.
    this.opening = true;
    if (
      params.sandbox !== "workspace-write" ||
      params.approvalPolicy !== "untrusted" ||
      params.approvalsReviewer !== "user" ||
      !params.modelProvider ||
      !params.cwd
    )
      throw new CodexTransportError("invalid_frame", "rejected");
    const response = await this.transport.request(method, params);
    const threadId = this.readIdentity(response, "thread");
    if (
      !record(response) ||
      (params.model != null && response.model !== params.model) ||
      (params.cwd != null && response.cwd !== params.cwd) ||
      response.modelProvider !== params.modelProvider ||
      response.approvalPolicy !== "untrusted" ||
      response.approvalsReviewer !== "user" ||
      !record(response.sandbox) ||
      response.sandbox.type !== "workspaceWrite" ||
      response.sandbox.networkAccess !== false ||
      response.sandbox.excludeTmpdirEnvVar !== true ||
      response.sandbox.excludeSlashTmp !== true ||
      !Array.isArray(response.sandbox.writableRoots) ||
      response.sandbox.writableRoots.some(
        (root: unknown) => root !== params.cwd,
      )
    )
      this.invalidResponse();
    if (expectedId !== undefined && threadId !== expectedId)
      this.invalidResponse();
    // A new admitted turn may continue an existing thread, but must never
    // turn/start into a native turn that is active or whose status is unknown.
    this.nativeIdle =
      record(response.thread) &&
      record(response.thread.status) &&
      response.thread.status.type === "idle";
    this.externalThreadId = threadId;
    return threadId;
  }

  async start(params: TurnStartParams): Promise<string> {
    this.assertThread(params.threadId);
    // turn/start can steer an active Codex turn. Never let a repeated start do that.
    if (!this.nativeIdle || this.startSubmitted || this.activeTurnId !== null)
      throw new CodexTransportError("invalid_frame", "rejected");
    this.startSubmitted = true;
    this.nativeIdle = false;
    const response = await this.transport.request("turn/start", params);
    const turnId = this.readIdentity(response, "turn");
    if (
      !record(response) ||
      !record(response.turn) ||
      response.turn.status !== "inProgress"
    )
      this.invalidResponse();
    this.activeTurnId = turnId;
    return this.activeTurnId;
  }

  async steer(params: TurnSteerParams): Promise<void> {
    this.assertThread(params.threadId);
    if (
      this.activeTurnId === null ||
      this.terminalStatus !== null ||
      params.expectedTurnId !== this.activeTurnId
    )
      throw new CodexTransportError("invalid_frame", "rejected");
    // A rejected/lost steer is never retried or converted into turn/start.
    const response = await this.transport.request("turn/steer", params);
    if (!record(response) || response.turnId !== this.activeTurnId)
      this.invalidResponse();
  }

  async interrupt(): Promise<void> {
    if (
      this.externalThreadId === null ||
      this.activeTurnId === null ||
      this.terminalStatus !== null
    )
      throw new CodexTransportError("invalid_frame", "rejected");
    const params: TurnInterruptParams = {
      threadId: this.externalThreadId,
      turnId: this.activeTurnId,
    };
    const response = await this.transport.request("turn/interrupt", params);
    if (!record(response) || Object.keys(response).length !== 0)
      this.invalidResponse();
    // RPC acceptance alone deliberately leaves the active turn in place.
  }

  async read(): Promise<unknown> {
    if (this.externalThreadId === null)
      throw new CodexTransportError("invalid_frame", "rejected");
    const params: ThreadReadParams = {
      threadId: this.externalThreadId,
      includeTurns: false,
    };
    const response = await this.transport.request("thread/read", params);
    if (this.readIdentity(response, "thread") !== this.externalThreadId)
      this.invalidResponse();
    return response;
  }

  /** Validate turn ownership before the driver translates a native terminal fact. */
  observeTerminal(params: unknown): "completed" | "interrupted" | "failed" {
    if (
      this.externalThreadId === null ||
      this.activeTurnId === null ||
      !record(params) ||
      params.threadId !== this.externalThreadId ||
      !record(params.turn) ||
      params.turn.id !== this.activeTurnId ||
      !["completed", "interrupted", "failed"].includes(
        String(params.turn.status),
      )
    )
      this.invalidResponse();
    const status = params.turn.status;
    if (
      status !== "completed" &&
      status !== "interrupted" &&
      status !== "failed"
    )
      this.invalidResponse();
    if (this.terminalStatus !== null && this.terminalStatus !== status)
      this.invalidResponse();
    // Same owned tuple/status is idempotent here. The driver compares the full
    // validated terminal payload and owns its single observation emission.
    // No next-start permission or quiescence claim follows completion/duplication.
    this.terminalStatus = status;
    return status;
  }

  private assertThread(threadId: string): void {
    if (this.externalThreadId === null || threadId !== this.externalThreadId)
      throw new CodexTransportError("invalid_frame", "rejected");
  }

  private readIdentity(response: unknown, key: "thread" | "turn"): string {
    if (!record(response)) return this.invalidResponse();
    const entity = response[key];
    if (!record(entity) || typeof entity.id !== "string" || !entity.id)
      return this.invalidResponse();
    return entity.id;
  }

  private invalidResponse(): never {
    this.transport.close();
    throw new CodexTransportError("invalid_frame");
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
