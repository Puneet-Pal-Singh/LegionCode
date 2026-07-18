import { describe, expect, it, vi } from "vitest";

const runWorkerPersistenceMigrations = vi.fn();

vi.mock("@repo/persistence", () => ({
  runWorkerPersistenceMigrations,
}));

describe("PersistenceMigrationWorker", () => {
  it("runs only through the scheduled operator boundary", async () => {
    runWorkerPersistenceMigrations.mockResolvedValue({
      applied: ["0028_task_checkout_secure_session"],
      skipped: ["0027_thread_title_preview_source"],
    });
    const worker = (await import("./PersistenceMigrationWorker")).default;

    expect("fetch" in worker).toBe(false);
    await worker.scheduled(
      {} as ScheduledEvent,
      { HYPERDRIVE: { connectionString: "postgres://redacted" } } as never,
      {} as ExecutionContext,
    );

    expect(runWorkerPersistenceMigrations).toHaveBeenCalledOnce();
  });
});
