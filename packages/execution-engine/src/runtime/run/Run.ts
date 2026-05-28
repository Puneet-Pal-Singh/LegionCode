// apps/brain/src/core/run/Run.ts
// Phase 3A: Run entity with state machine transitions

import type {
  RunStatus,
  AgentType,
  RunInput,
  RunOutput,
  RunMetadata,
  SerializedRun,
} from "../types.js";
import { RunStateMachine } from "./RunStateMachine.js";

export class Run {
  constructor(
    readonly id: string,
    readonly sessionId: string,
    public status: RunStatus,
    readonly agentType: AgentType,
    readonly input: RunInput,
    public output?: RunOutput,
    public metadata: RunMetadata = { prompt: input.prompt },
    readonly createdAt: Date = new Date(),
    public updatedAt: Date = new Date(),
  ) {}

  transition(newStatus: RunStatus): void {
    if (!RunStateMachine.isValidTransition(this.status, newStatus)) {
      throw new InvalidStateTransitionError(this.status, newStatus);
    }

    this.status = newStatus;
    this.updatedAt = new Date();

    if (newStatus === "RUNNING" && !this.metadata.startedAt) {
      this.metadata.startedAt = new Date().toISOString();
    }

    if (["PAUSED", "COMPLETED", "FAILED", "CANCELLED"].includes(newStatus)) {
      this.metadata.completedAt = new Date().toISOString();
    }
  }

  toJSON(): SerializedRun {
    return {
      id: this.id,
      sessionId: this.sessionId,
      status: this.status,
      agentType: this.agentType,
      input: this.input,
      output: this.output,
      metadata: this.metadata,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
    };
  }

  static fromJSON(data: SerializedRun): Run {
    return new Run(
      data.id,
      data.sessionId,
      data.status,
      data.agentType,
      data.input,
      data.output,
      data.metadata,
      new Date(data.createdAt),
      new Date(data.updatedAt),
    );
  }
}

export class InvalidStateTransitionError extends Error {
  constructor(from: RunStatus, to: RunStatus) {
    super(`[run/state] Invalid transition from ${from} to ${to}`);
    this.name = "InvalidStateTransitionError";
  }
}
