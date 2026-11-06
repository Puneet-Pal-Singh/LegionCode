import { AppServerOperationError, type AppServerComposition } from "@legioncode/app-server/server";
import type { AppServerRequest } from "@legioncode/app-server/protocol";
import { z } from "zod";
import { resolveOwnedCheckoutExecution } from "./OwnedCheckoutExecution";
import { isDomainError, mapDomainErrorToHttp } from "../../domain/errors";
import type { Env } from "../../types/ai";

type ListParams = Extract<AppServerRequest, { method: "checkout/listFiles" }>["params"];
type ReadParams = Extract<AppServerRequest, { method: "checkout/readFile" }>["params"];
const ExecutionResultSchema = z.object({ status: z.string(), output: z.string().optional() });

/** The existing filesystem plugin executes reads using the exact original lease. */
export function composeHostedCheckoutReads(
  request: Request,
  env: Env,
  userId: string,
): NonNullable<AppServerComposition["hostedCheckoutReadsService"]> {
  async function executeRead(action: "list_files" | "read_file", params: ReadParams | ListParams): Promise<string> {
    const execution = await resolveOwnedCheckoutExecution(request, env, userId, params);
    const url = new URL("/api/v1/execute", "http://internal");
    url.searchParams.set("session", execution.brainSessionId);
    const response = await env.SECURE_API.fetch(url.toString(), {
      method: "POST",
      headers: { Authorization: `Bearer ${execution.session.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: execution.session.sessionId,
        taskId: `checkout-read-${crypto.randomUUID()}`,
        action: "filesystem.execute",
        borrowedLease: {
          leaseId: execution.session.lease.leaseId,
          sandboxId: execution.session.lease.sandboxId,
          generation: execution.session.lease.generation,
        },
        params: { action, path: params.path, runId: execution.runId, workspaceScope: execution.workspaceScope,
          ...(action === "list_files" ? { offset: "offset" in params ? params.offset : undefined, limit: 200 } : {}),
        },
        timeout: 30_000,
      }),
    });
    if (!response.ok) throw unavailable();
    const result = ExecutionResultSchema.parse(await response.json());
    if (result.status !== "success" || result.output === undefined) throw unavailable();
    return result.output;
  }
  async function read(action: "list_files" | "read_file", params: ReadParams | ListParams): Promise<string> {
    try { return await executeRead(action, params); }
    catch (error) {
      if (error instanceof AppServerOperationError) throw error;
      if (isDomainError(error)) {
        const mapped = mapDomainErrorToHttp(error);
        throw new AppServerOperationError(mapped.status, mapped.status === 401 ? "unauthorized" : mapped.status === 403 ? "forbidden" : mapped.status === 400 ? "invalid_request" : "server_unavailable", mapped.message, mapped.code, error.retryable);
      }
      throw unavailable();
    }
  }
  return {
    listFiles: async (params) => {
      const output = await read("list_files", params);
      const lines = output.split("\n").filter(Boolean);
      const truncated = lines.some((line) => /^\.\.\. and \d+ more files \(Total: \d+\)$/.test(line));
      const entries = lines.filter((line) => !/^\.\.\. and \d+ more files \(Total: \d+\)$/.test(line)).map((line) => ({
        name: line.endsWith("/") ? line.slice(0, -1) : line,
        type: line.endsWith("/") ? "directory" as const : "file" as const,
      }));
      // Entry names cannot supply a different path to the client.
      if (entries.some(({ name }) => !name || name === "." || name === ".." || /[/\\\0]/.test(name))) throw unavailable();
      if (truncated && entries.length === 0) throw unavailable();
      return { entries, truncated, nextOffset: truncated ? (params.offset ?? 0) + entries.length : null };
    },
    readFile: async (params) => {
      const output = await read("read_file", params);
      return { output, isBinary: output === "[BINARY_FILE_DETECTED]" };
    },
  };
}

function unavailable(): AppServerOperationError {
  return new AppServerOperationError(503, "server_unavailable", "The file could not be read from the original checkout.", "CHECKOUT_READ_UNAVAILABLE", false);
}
