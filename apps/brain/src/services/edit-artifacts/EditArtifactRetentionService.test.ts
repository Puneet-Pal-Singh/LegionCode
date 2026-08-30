import { describe, expect, it, vi } from "vitest";
import type { Env } from "../../types/ai";
import { EditArtifactRetentionService } from "./EditArtifactRetentionService";

describe("EditArtifactRetentionService", () => {
  it.each([" block_runs ", "BLOCK_RUNS"])(
    "does not query or mutate storage while run admission is blocked (%s)",
    async (mode) => {
      const artifacts = {
        delete: vi.fn(),
        get: vi.fn(),
        put: vi.fn(),
      };
      const env = {
        LAUNCH_EMERGENCY_SHUTOFF_MODE: mode,
        EDIT_ARTIFACTS: artifacts,
      } as unknown as Env;

      await expect(
        new EditArtifactRetentionService(env).expireArtifacts(
          "2026-08-27T00:00:00.000Z",
        ),
      ).resolves.toEqual({ expiredCount: 0, repairedPendingCount: 0 });

      expect(artifacts.delete).not.toHaveBeenCalled();
      expect(artifacts.get).not.toHaveBeenCalled();
      expect(artifacts.put).not.toHaveBeenCalled();
    },
  );
});
