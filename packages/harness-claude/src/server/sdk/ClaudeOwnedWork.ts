import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/** Native evidence only, applied after the canonical sink acknowledges each message.
 * Background membership is a level signal independent of the task edge stream.
 */
export class ClaudeOwnedWork {
  private state: "idle" | "running" | "requires_action" | "unavailable" =
    "unavailable";
  private readonly tasks = new Map<string, string | undefined>();
  private readonly ended = new Map<string, string | undefined>();
  private readonly background = new Map<string, string | undefined>();

  submitted(): void {
    this.state = "running";
  }

  observe(message: SDKMessage): void {
    if (message.type !== "system") return;
    if (message.subtype === "session_state_changed") this.state = message.state;
    if (message.subtype === "background_tasks_changed") {
      if (message.tasks.length > 4096)
        throw new Error("Claude task tracking limit exceeded");
      this.background.clear();
      for (const task of message.tasks)
        this.background.set(task.task_id, task.run_id);
    }
    if (message.subtype === "task_started") {
      const previous = this.tasks.get(message.task_id);
      const ended = this.ended.get(message.task_id);
      // Retain run tombstones: late starts must not resurrect an ended run.
      if (
        (this.ended.has(message.task_id) &&
          (ended === undefined ||
            message.run_id === undefined ||
            message.run_id <= ended)) ||
        (this.tasks.has(message.task_id) &&
          (message.run_id === undefined ||
            (previous !== undefined && message.run_id < previous)))
      )
        return;
      if (this.tasks.size >= 4096 && !this.tasks.has(message.task_id))
        throw new Error("Claude task tracking limit exceeded");
      this.tasks.set(message.task_id, message.run_id);
    }
    if (message.subtype === "task_notification") {
      const previous = this.ended.get(message.task_id);
      if (
        !this.ended.has(message.task_id) ||
        (message.run_id !== undefined &&
          (previous === undefined || message.run_id > previous))
      ) {
        if (this.ended.size >= 4096 && !this.ended.has(message.task_id))
          throw new Error("Claude task tracking limit exceeded");
        this.ended.set(message.task_id, message.run_id);
      }
      if (
        this.tasks.has(message.task_id) &&
        this.tasks.get(message.task_id) === message.run_id
      )
        this.tasks.delete(message.task_id);
      // Never remove a background snapshot entry from an edge notification.
    }
  }

  get settled(): boolean {
    return (
      this.state === "idle" &&
      this.tasks.size === 0 &&
      this.background.size === 0
    );
  }

  /** Includes ambient tasks: invisible activity can still mutate the workspace. */
  running(): ReadonlyMap<string, string | undefined> {
    const tasks = new Map(this.tasks);
    for (const [id, run] of this.background) {
      const previous = tasks.get(id);
      if (
        !tasks.has(id) ||
        previous === undefined ||
        (run !== undefined && run > previous)
      )
        tasks.set(id, run);
    }
    return tasks;
  }
}
