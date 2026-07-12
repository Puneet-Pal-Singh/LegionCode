import { fetchCloudflareAgentRoute } from "./sdk.js";

export interface CloudflareAgentsRunRuntimeClientBinding {
  namespace: unknown;
}

export interface RunRuntimeExecuteRequest {
  runId: string;
  payload: unknown;
}

export interface RunRuntimeSummaryRequest {
  runId: string;
}

export interface RunRuntimeInterruptRequest {
  runId: string;
  payload: unknown;
}

export class CloudflareAgentsRunRuntimeClient {
  constructor(
    private readonly binding: CloudflareAgentsRunRuntimeClientBinding,
  ) {}

  async execute(request: RunRuntimeExecuteRequest): Promise<Response> {
    return this.fetchRoute(request.runId, "/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request.payload),
    });
  }

  async getSummary(request: RunRuntimeSummaryRequest): Promise<Response> {
    const url = new URL("https://shadowbox-agent/summary");
    url.searchParams.set("runId", request.runId);
    return this.fetchRoute(request.runId, url.toString(), {
      method: "GET",
    });
  }

  async interrupt(request: RunRuntimeInterruptRequest): Promise<Response> {
    return this.fetchRoute(request.runId, "/interrupt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request.payload),
    });
  }

  private async fetchRoute(
    runId: string,
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    const request = new Request(
      path.startsWith("http") ? path : `https://shadowbox-agent${path}`,
      init,
    );
    return fetchCloudflareAgentRoute(this.binding, runId, request);
  }
}
