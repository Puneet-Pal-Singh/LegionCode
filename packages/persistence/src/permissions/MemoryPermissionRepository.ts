import type {
  CreatePermissionDecisionInput,
  CreatePermissionRequestInput,
  PermissionDecisionRecord,
  PermissionRepository,
  PermissionRequestRecord,
} from "./types.js";
import {
  PERMISSION_DECISION_KINDS,
  PERMISSION_REQUEST_STATUSES,
  resolvePermissionRequestStatus,
} from "./types.js";

interface Clock {
  now(): Date;
}

const systemClock: Clock = {
  now: () => new Date(),
};

export class MemoryPermissionRepository implements PermissionRepository {
  private readonly requests: PermissionRequestRecord[] = [];
  private readonly decisions: PermissionDecisionRecord[] = [];
  private idCounter = 0;

  constructor(private readonly clock: Clock = systemClock) {}

  private nextId(prefix: string): string {
    this.idCounter += 1;
    return `${prefix}-${this.idCounter}`;
  }

  async createRequest(
    input: CreatePermissionRequestInput,
  ): Promise<PermissionRequestRecord> {
    const status = input.status ?? "pending";

    if (
      !PERMISSION_REQUEST_STATUSES.includes(
        status as (typeof PERMISSION_REQUEST_STATUSES)[number],
      )
    ) {
      throw new Error(`Unsupported permission request status: ${status}`);
    }

    const record = {
      id: this.nextId("pr"),
      userId: input.userId,
      sessionId: input.sessionId,
      runId: input.runId,
      requestType: input.requestType,
      status,
      payload: input.payload ?? null,
      expiresAt: input.expiresAt ?? null,
      createdAt: this.clock.now().toISOString(),
      resolvedAt: null,
    } satisfies PermissionRequestRecord;

    this.requests.push(record);
    return record;
  }

  async createDecision(
    input: CreatePermissionDecisionInput,
  ): Promise<PermissionDecisionRecord> {
    if (!PERMISSION_DECISION_KINDS.includes(input.decision)) {
      throw new Error(`Unsupported permission decision kind: ${input.decision}`);
    }

    const requestIndex = this.requests.findIndex(
      (request) =>
        request.id === input.permissionRequestId &&
        request.userId === input.userId,
    );
    const request = this.requests[requestIndex];
    if (!request) {
      throw new Error(`Permission request not found: ${input.permissionRequestId}`);
    }

    const now = this.clock.now().toISOString();
    const record = {
      id: this.nextId("pd"),
      permissionRequestId: input.permissionRequestId,
      userId: input.userId,
      decision: input.decision,
      payload: input.payload ?? null,
      createdAt: now,
    } satisfies PermissionDecisionRecord;

    this.decisions.push(record);
    this.requests[requestIndex] = {
      ...request,
      status: resolvePermissionRequestStatus(input.decision),
      resolvedAt: now,
    };

    return record;
  }

  async listRequestsByRun(
    runId: string,
    userId?: string,
  ): Promise<PermissionRequestRecord[]> {
    return this.requests.filter(
      (r) => r.runId === runId && (!userId || r.userId === userId),
    );
  }

  async listDecisionsByRequest(
    requestId: string,
    userId?: string,
  ): Promise<PermissionDecisionRecord[]> {
    const request = this.requests.find((r) => r.id === requestId);
    if (!request || (userId && request.userId !== userId)) {
      return [];
    }

    return this.decisions.filter(
      (d) => d.permissionRequestId === requestId,
    );
  }

  async transaction<T>(
    callback: (repository: PermissionRepository) => Promise<T>,
  ): Promise<T> {
    return await callback(this);
  }
}
