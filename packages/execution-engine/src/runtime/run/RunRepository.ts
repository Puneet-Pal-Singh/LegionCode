// RECONSTRUCTABILITY: Run state in DO storage is the live runtime source of
// truth during active execution. Completed run records are persisted to
// Postgres via PostgresRunRepository. If DO storage is lost, active runs
// will fail (expected), but completed runs can be reloaded from Postgres.
// Session-run index can be rebuilt from Postgres RunRecord rows.

import { Run } from "./Run.js";
import type {
  RunStatus,
  RuntimeDurableObjectState,
  SerializedRun,
} from "../types.js";

export interface IRunRepository {
  create(run: Run): Promise<void>;
  getById(runId: string): Promise<Run | null>;
  getBySession(sessionId: string): Promise<Run[]>;
  update(run: Run): Promise<void>;
  updateUnlessStatus(run: Run, blockedStatuses: RunStatus[]): Promise<boolean>;
  listActiveRuns(): Promise<Run[]>;
}

export class RunRepository implements IRunRepository {
  private readonly RUN_KEY_PREFIX = "run:";
  private readonly SESSION_RUNS_KEY_PREFIX = "session_runs:";

  constructor(private ctx: RuntimeDurableObjectState) {}

  private getRunKey(runId: string): string {
    return `${this.RUN_KEY_PREFIX}${runId}`;
  }

  private getSessionRunsKey(sessionId: string): string {
    return `${this.SESSION_RUNS_KEY_PREFIX}${sessionId}`;
  }

  async create(run: Run): Promise<void> {
    const runKey = this.getRunKey(run.id);
    const sessionRunsKey = this.getSessionRunsKey(run.sessionId);

    await this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.put(runKey, run.toJSON());

      const existingRunIds =
        (await this.ctx.storage.get<string[]>(sessionRunsKey)) ?? [];
      if (!existingRunIds.includes(run.id)) {
        await this.ctx.storage.put(sessionRunsKey, [...existingRunIds, run.id]);
      }
    });

  }

  async getById(runId: string): Promise<Run | null> {
    const data = await this.ctx.storage.get<SerializedRun>(
      this.getRunKey(runId),
    );

    if (!data) {
      return null;
    }

    return Run.fromJSON(data);
  }

  async getBySession(sessionId: string): Promise<Run[]> {
    const runIds =
      (await this.ctx.storage.get<string[]>(
        this.getSessionRunsKey(sessionId),
      )) ?? [];
    const runs: Run[] = [];

    for (const runId of runIds) {
      const run = await this.getById(runId);
      if (run) {
        runs.push(run);
      }
    }

    return runs;
  }

  async update(run: Run): Promise<void> {
    const runKey = this.getRunKey(run.id);

    await this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.put(runKey, run.toJSON());
    });

  }

  async updateUnlessStatus(
    run: Run,
    blockedStatuses: RunStatus[],
  ): Promise<boolean> {
    const runKey = this.getRunKey(run.id);
    let didUpdate = false;

    await this.ctx.blockConcurrencyWhile(async () => {
      const current = await this.ctx.storage.get<SerializedRun>(runKey);
      if (current && blockedStatuses.includes(current.status)) {
        return;
      }
      await this.ctx.storage.put(runKey, run.toJSON());
      didUpdate = true;
    });

    return didUpdate;
  }

  async listActiveRuns(): Promise<Run[]> {
    const allRuns: Run[] = [];
    const listResult = await this.ctx.storage.list<SerializedRun>({
      prefix: this.RUN_KEY_PREFIX,
    });

    for (const [, data] of listResult) {
      const run = Run.fromJSON(data);
      if (["CREATED", "PLANNING", "RUNNING"].includes(run.status)) {
        allRuns.push(run);
      }
    }

    return allRuns;
  }
}

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`[run/repo] Run not found: ${runId}`);
    this.name = "RunNotFoundError";
  }
}
