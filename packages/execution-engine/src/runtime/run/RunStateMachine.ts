// apps/brain/src/core/run/RunStateMachine.ts
// Phase 3A: Run state machine logic and utilities

import type { RunStatus } from "../types.js";
import { StateMachineError } from "@shadowbox/orchestrator-core";

export interface StateTransition {
  from: RunStatus;
  to: RunStatus;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export class RunStateMachine {
  private transitions: StateTransition[] = [];

  private static readonly VALID_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
    CREATED: ["PLANNING", "RUNNING", "CANCELLED"],
    PLANNING: ["RUNNING", "FAILED", "CANCELLED"],
    RUNNING: ["PAUSED", "COMPLETED", "FAILED", "CANCELLED"],
    PAUSED: [],
    COMPLETED: [],
    FAILED: [],
    CANCELLED: [],
  };

  static isValidTransition(from: RunStatus, to: RunStatus): boolean {
    return this.VALID_TRANSITIONS[from]?.includes(to) ?? false;
  }

  static getValidTransitions(status: RunStatus): RunStatus[] {
    return this.VALID_TRANSITIONS[status] || [];
  }

  static isTerminalState(status: RunStatus): boolean {
    return ["PAUSED", "COMPLETED", "FAILED", "CANCELLED"].includes(status);
  }

  static isActiveState(status: RunStatus): boolean {
    return ["CREATED", "PLANNING", "RUNNING"].includes(status);
  }

  recordTransition(
    from: RunStatus,
    to: RunStatus,
    metadata?: Record<string, unknown>,
  ): void {
    this.transitions.push({
      from,
      to,
      timestamp: new Date(),
      metadata,
    });
  }

  getTransitions(): StateTransition[] {
    return [...this.transitions];
  }

  getCurrentDuration(): number {
    const lastTransition = this.transitions[this.transitions.length - 1];
    if (!lastTransition) {
      return 0;
    }
    return Date.now() - lastTransition.timestamp.getTime();
  }

  getTotalDuration(): number {
    const firstTransition = this.transitions[0];
    const lastTransition = this.transitions[this.transitions.length - 1];
    if (!firstTransition || !lastTransition) {
      return 0;
    }
    return (
      lastTransition.timestamp.getTime() - firstTransition.timestamp.getTime()
    );
  }
}

export function validateStateTransition(from: RunStatus, to: RunStatus): void {
  if (!RunStateMachine.isValidTransition(from, to)) {
    throw new StateMachineError(
      `Invalid transition from "${from}" to "${to}". ` +
        `Valid transitions from "${from}" are: ${RunStateMachine.getValidTransitions(from).join(", ") || "none (terminal state)"}`,
    );
  }
}

export { StateMachineError };
