// RECONSTRUCTABILITY: This repository stores only the active per-run
// execution queue in Durable Object storage. Product task/session records
// are canonical in Postgres transcript tables. DO state loss can interrupt
// an active run, but it must not erase user-visible task history.

import { Task } from "./Task.js";
import type {
  RuntimeDurableObjectState,
  TaskStatus,
  SerializedTask,
} from "../types.js";

export interface ITaskRepository {
  create(task: Task): Promise<void>;
  getById(taskId: string, runId: string): Promise<Task | null>;
  getByRun(runId: string): Promise<Task[]>;
  getByRunAndStatus(runId: string, status: TaskStatus): Promise<Task[]>;
  getByIds(taskIds: string[], runId: string): Promise<Task[]>;
  update(task: Task): Promise<void>;
  updateMany(tasks: Task[]): Promise<void>;
  deleteByRun(runId: string): Promise<void>;
}

export class TaskRepository implements ITaskRepository {
  private readonly TASK_KEY_PREFIX = "task:";
  private readonly RUN_TASKS_KEY_PREFIX = "run_tasks:";

  constructor(private ctx: RuntimeDurableObjectState) {}

  private getTaskKey(taskId: string, runId: string): string {
    return `${this.TASK_KEY_PREFIX}${runId}:${taskId}`;
  }

  private getRunTasksKey(runId: string): string {
    return `${this.RUN_TASKS_KEY_PREFIX}${runId}`;
  }

  async create(task: Task): Promise<void> {
    const taskKey = this.getTaskKey(task.id, task.runId);
    const runTasksKey = this.getRunTasksKey(task.runId);

    await this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.put(taskKey, task.toJSON());

      const existingTaskIds =
        (await this.ctx.storage.get<string[]>(runTasksKey)) ?? [];
      if (!existingTaskIds.includes(task.id)) {
        await this.ctx.storage.put(runTasksKey, [...existingTaskIds, task.id]);
      }
    });

    console.log(`[task/repo] Created task ${task.id} for run ${task.runId}`);
  }

  async getById(taskId: string, runId: string): Promise<Task | null> {
    const data = await this.ctx.storage.get<SerializedTask>(
      this.getTaskKey(taskId, runId),
    );

    if (!data) {
      return null;
    }

    return Task.fromJSON(data);
  }

  async getByRun(runId: string): Promise<Task[]> {
    const taskIds =
      (await this.ctx.storage.get<string[]>(this.getRunTasksKey(runId))) ?? [];
    const tasks: Task[] = [];

    for (const taskId of taskIds) {
      const task = await this.getById(taskId, runId);
      if (task) {
        tasks.push(task);
      }
    }

    return tasks;
  }

  async getByRunAndStatus(runId: string, status: TaskStatus): Promise<Task[]> {
    const allTasks = await this.getByRun(runId);
    return allTasks.filter((task) => task.status === status);
  }

  async getByIds(taskIds: string[], runId: string): Promise<Task[]> {
    const tasks: Task[] = [];

    for (const taskId of taskIds) {
      const task = await this.getById(taskId, runId);
      if (task) {
        tasks.push(task);
      }
    }

    return tasks;
  }

  async update(task: Task): Promise<void> {
    const taskKey = this.getTaskKey(task.id, task.runId);

    await this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.put(taskKey, task.toJSON());
    });

    console.log(`[task/repo] Updated task ${task.id} to status ${task.status}`);
  }

  async updateMany(tasks: Task[]): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      for (const task of tasks) {
        const taskKey = this.getTaskKey(task.id, task.runId);
        await this.ctx.storage.put(taskKey, task.toJSON());
      }
    });

    console.log(`[task/repo] Updated ${tasks.length} tasks`);
  }

  async deleteByRun(runId: string): Promise<void> {
    const runTasksKey = this.getRunTasksKey(runId);

    await this.ctx.blockConcurrencyWhile(async () => {
      // Read taskIds inside blockConcurrencyWhile to prevent TOCTOU race condition
      const taskIds = (await this.ctx.storage.get<string[]>(runTasksKey)) ?? [];

      for (const taskId of taskIds) {
        await this.ctx.storage.delete(this.getTaskKey(taskId, runId));
      }
      await this.ctx.storage.delete(runTasksKey);

      console.log(
        `[task/repo] Deleted ${taskIds.length} tasks for run ${runId}`,
      );
    });
  }
}

export class TaskNotFoundError extends Error {
  constructor(taskId: string, runId: string) {
    super(`[task/repo] Task not found: ${taskId} in run ${runId}`);
    this.name = "TaskNotFoundError";
  }
}
