import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ DurableObject: class DurableObject {} }));
import worker, { type Env } from "./index";

describe("Brain auth route wiring", () => {
  it("registers logout as a POST route", () => {
    const workerSource = readFileSync(
      new URL("./index.ts", import.meta.url),
      "utf8",
    );

    expect(workerSource).toContain(
      'router.add(/\\/auth\\/logout/, AuthController.handleLogout, "POST");',
    );
  });

  it("does not touch repository or R2 from scheduled retention during run freeze", async () => {
    const env = new Proxy(
      { LAUNCH_EMERGENCY_SHUTOFF_MODE: " BLOCK_RUNS " },
      {
        get(target, property) {
          if (property === "EDIT_ARTIFACTS" || property === "HYPERDRIVE") {
            throw new Error(`unexpected scheduled storage access: ${String(property)}`);
          }
          return Reflect.get(target, property);
        },
      },
    ) as Env;

    await expect(
      worker.scheduled(
        {} as ScheduledEvent,
        env,
        {} as ExecutionContext,
      ),
    ).resolves.toBeUndefined();
  });
});
