import { Run } from "../run/index.js";
import { Task } from "../task/index.js";
import type { RunStatus } from "../types.js";

export function determineRunStatusFromTasks(tasks: Task[]): RunStatus {
  if (tasks.some((task) => task.status === "CANCELLED")) {
    return "CANCELLED";
  }
  if (tasks.some((task) => task.status === "FAILED")) {
    return "FAILED";
  }
  if (tasks.some((task) => task.status !== "DONE")) {
    return "RUNNING";
  }
  return "COMPLETED";
}

export function applyFinalRunStatus(
  run: Run,
  runId: string,
  finalRunStatus: RunStatus,
  tasks: Task[],
): void {
  if (finalRunStatus === "RUNNING") {
    return;
  }

  if (finalRunStatus === "COMPLETED") {
    transitionRunToCompleted(run, runId);
    return;
  }

  if (finalRunStatus === "FAILED") {
    transitionRunToFailed(run, runId);
    const failedTasks = tasks.filter((task) => task.status === "FAILED");
    const summary = failedTasks
      .map((task) => `${task.id}: ${task.error?.message ?? "Task failed"}`)
      .join("; ");
    run.metadata.error = summary || "One or more tasks failed";
    return;
  }

  if (run.status === "FAILED" || run.status === "COMPLETED") {
    return;
  }

  ensureRunReadyForTerminalTransition(run);
  if (run.status === "RUNNING") {
    run.transition("CANCELLED");
  }
}

export function transitionRunToCompleted(run: Run, runId: string): void {
  if (run.status === "COMPLETED") {
    return;
  }

  if (run.status === "FAILED" || run.status === "CANCELLED") {
    console.warn(
      `[run/engine] Skipping COMPLETED transition for run ${runId}; current status is ${run.status}`,
    );
    return;
  }

  ensureRunReadyForTerminalTransition(run);
  if (run.status === "RUNNING") {
    run.transition("COMPLETED");
  }
}

export function transitionRunToPaused(run: Run, runId: string): void {
  if (run.status === "PAUSED" || run.status === "CANCELLED") {
    return;
  }

  if (run.status === "COMPLETED" || run.status === "FAILED") {
    console.warn(
      `[run/engine] Preserving ${run.status} state for run ${runId} after recoverable pause`,
    );
    return;
  }

  ensureRunReadyForTerminalTransition(run);
  if (run.status === "RUNNING") {
    run.transition("PAUSED");
    return;
  }

  console.warn(
    `[run/engine] Unable to move run ${runId} to PAUSED from status ${run.status}`,
  );
}

export function transitionRunToFailed(run: Run, runId: string): void {
  if (run.status === "FAILED" || run.status === "CANCELLED") {
    return;
  }

  if (run.status === "COMPLETED") {
    console.warn(
      `[run/engine] Preserving COMPLETED state for run ${runId} after post-completion error`,
    );
    return;
  }

  ensureRunReadyForTerminalTransition(run);
  if (run.status === "RUNNING") {
    run.transition("FAILED");
    return;
  }

  console.warn(
    `[run/engine] Unable to move run ${runId} to FAILED from status ${run.status}`,
  );
}

export function ensureRunReadyForTerminalTransition(run: Run): void {
  if (
    run.status === "CREATED" ||
    run.status === "PLANNING" ||
    run.status === "PAUSED"
  ) {
    run.transition("RUNNING");
  }
}
