import { describe, expect, it } from "vitest";
import { RunExecutionLock } from "./RunExecutionLock";

describe("RunExecutionLock", () => {
  it("serializes operations for the same run", async () => {
    const lock = new RunExecutionLock();
    const order: string[] = [];
    let releaseFirst = () => {};

    const first = lock.run("run-a", async () => {
      order.push("first-start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first-end");
    });
    const second = lock.run("run-a", async () => {
      order.push("second-start");
    });

    await waitFor(() => order.includes("first-start"));
    expect(order).toEqual(["first-start"]);
    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(["first-start", "first-end", "second-start"]);
    expect(lock.pendingRunCount()).toBe(0);
  });

  it("allows different runs to execute concurrently", async () => {
    const lock = new RunExecutionLock();
    const order: string[] = [];
    let releaseFirst = () => {};

    const first = lock.run("run-a", async () => {
      order.push("run-a-start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("run-a-end");
    });
    const second = lock.run("run-b", async () => {
      order.push("run-b-start");
    });

    await second;
    expect(order).toEqual(["run-a-start", "run-b-start"]);
    releaseFirst();
    await first;
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
