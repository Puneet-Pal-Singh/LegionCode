import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const mocks = vi.hoisted(() => ({
  children: [] as FakeChild[],
  initialize: vi.fn(),
  request: vi.fn(),
}));

type FakeChild = {
  pid: number;
  postMessage(message: unknown): void;
  kill(): void;
  emit(event: string, ...args: unknown[]): void;
};

vi.mock("electron", () => ({
  utilityProcess: {
    fork: vi.fn(() => {
      const child = new TestChild(mocks.children.length + 1);
      mocks.children.push(child);
      return child;
    }),
  },
}));

vi.mock("@legioncode/sdk", () => ({
  createAppServerHttpTransport: () => ({ request: mocks.request }),
  createAppServerClient: () => ({ initialize: mocks.initialize }),
}));

import { LocalAppServerSupervisor } from "./local-app-server-supervisor";

class TestChild extends EventEmitter implements FakeChild {
  constructor(readonly pid: number) {
    super();
  }

  postMessage(_message: unknown): void {}

  kill(): void {}
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const handshake = {
  protocolVersion: "1.0.0",
  server: { id: "legioncode-app-server", version: "test" },
  environment: "local",
  capabilities: ["thread-management-v1"],
  unavailableCapabilities: [],
};

async function settleMessages(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function childAt(index: number): FakeChild {
  const child = mocks.children[index];
  if (!child) throw new Error(`Expected test child ${index}`);
  return child;
}

describe("Local App Server supervisor generation safety", () => {
  beforeEach(() => {
    mocks.children.length = 0;
    mocks.initialize.mockReset();
    mocks.request.mockReset();
  });

  it("cannot restore ready state from a handshake after the child was stopped", async () => {
    const handshakeResult = deferred<unknown>();
    mocks.initialize.mockReturnValue(handshakeResult.promise);
    const supervisor = new LocalAppServerSupervisor();
    await supervisor.start("1.0.0", "/private/user-data");
    const child = childAt(0);
    child.emit("message", { type: "ready", baseUrl: "http://127.0.0.1:4312" });
    await settleMessages();

    const stopping = supervisor.stop();
    child.emit("exit");
    await stopping;
    handshakeResult.resolve(handshake);
    await settleMessages();

    expect(supervisor.getEnvironment().status).toBe("stopped");
  });

  it("rejects an in-flight request when its server generation is stopped", async () => {
    mocks.initialize.mockResolvedValue(handshake);
    const requestResult = deferred<unknown>();
    mocks.request.mockReturnValue(requestResult.promise);
    const supervisor = new LocalAppServerSupervisor();
    await supervisor.start("1.0.0", "/private/user-data");
    const child = childAt(0);
    child.emit("message", { type: "ready", baseUrl: "http://127.0.0.1:4312" });
    await settleMessages();
    expect(supervisor.getEnvironment().status).toBe("ready");

    const request = supervisor.request({
      protocolVersion: "1.0.0",
      method: "thread/list",
      params: {},
    });
    const stopping = supervisor.stop();
    child.emit("exit");
    await stopping;
    requestResult.resolve({ ok: true });
    await expect(request).rejects.toThrow("Local App Server changed during the request");
  });

  it("coalesces concurrent restart requests around the same child", async () => {
    const supervisor = new LocalAppServerSupervisor();
    await supervisor.start("1.0.0", "/private/user-data");
    const firstChild = childAt(0);

    const firstRestart = supervisor.restart("1.0.0");
    const secondRestart = supervisor.restart("1.0.0");
    expect(mocks.children).toHaveLength(1);
    firstChild.emit("exit");
    await Promise.all([firstRestart, secondRestart]);

    expect(mocks.children).toHaveLength(2);
    const stopping = supervisor.stop();
    childAt(1).emit("exit");
    await stopping;
  });

  it("does not relaunch after shutdown overtakes a pending restart", async () => {
    const supervisor = new LocalAppServerSupervisor();
    await supervisor.start("1.0.0", "/private/user-data");
    const child = childAt(0);
    const restart = supervisor.restart("1.0.0");
    const shutdown = supervisor.stop();
    child.emit("exit");
    await Promise.all([restart, shutdown]);

    expect(mocks.children).toHaveLength(1);
    expect(supervisor.getEnvironment().status).toBe("stopped");
  });
});
