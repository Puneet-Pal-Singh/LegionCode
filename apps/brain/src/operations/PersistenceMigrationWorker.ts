import { runWorkerPersistenceMigrations } from "@repo/persistence";
import type { Env } from "../types/ai";

/**
 * Scheduled-only operator worker. It deliberately has no fetch handler and is
 * never bound to a public route or to the production Brain service.
 */
export default {
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    _context: ExecutionContext,
  ): Promise<void> {
    const result = await runWorkerPersistenceMigrations(env);
    console.log(
      `[persistence/migrations] status=completed applied=${formatIds(result.applied)} skipped=${formatIds(result.skipped)}`,
    );
  },
};

function formatIds(ids: readonly string[]): string {
  return ids.length > 0 ? ids.join(",") : "none";
}
