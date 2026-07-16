import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareAgentsRunRuntimeClient } from "./CloudflareAgentsRunRuntimeClient.js";
import { fetchCloudflareAgentRoute } from "./sdk.js";

vi.mock("./sdk.js", () => ({
  fetchCloudflareAgentRoute: vi.fn(),
}));

describe("CloudflareAgentsRunRuntimeClient", () => {
  const binding = {
    namespace: {} as DurableObjectNamespace,
  };

  beforeEach(() => {
    vi.mocked(fetchCloudflareAgentRoute).mockReset();
    vi.mocked(fetchCloudflareAgentRoute).mockResolvedValue(
      new Response("ok", { status: 200 }),
    );
  });

  it("routes execute calls through the named agent instance", async () => {
    const client = new CloudflareAgentsRunRuntimeClient(binding);

    await client.execute({
      runId: "run-1",
      payload: { hello: "world" },
    });

    expect(fetchCloudflareAgentRoute).toHaveBeenCalledTimes(1);
    const [, name, request] = vi.mocked(fetchCloudflareAgentRoute).mock.calls[0];
    expect(name).toBe("run-1");
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://shadowbox-agent/execute");
    expect(await request.text()).toBe(JSON.stringify({ hello: "world" }));
  });

  it("routes summary and cancel calls to the same agent instance", async () => {
    const client = new CloudflareAgentsRunRuntimeClient(binding);

    await client.getSummary({ runId: "run-2" });
    await client.interrupt({ runId: "run-2", payload: { runId: "run-2" } });

    const calls = vi.mocked(fetchCloudflareAgentRoute).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[1]).toBe("run-2");
    expect(calls[1]?.[1]).toBe("run-2");
    expect(calls[0]?.[2].url).toBe("https://shadowbox-agent/summary?runId=run-2");
    expect(calls[1]?.[2].url).toBe("https://shadowbox-agent/interrupt");
  });
});
