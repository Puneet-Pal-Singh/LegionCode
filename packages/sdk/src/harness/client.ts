import {
  AppServerResultSchemas,
  type AppServerRequest,
  type AppServerSuccessResponse,
} from "@legioncode/app-server/protocol";
import { requestAppServerOperation, type AppServerClientOptions } from "../platform/app-server-client.js";

/** The same authenticated App Server transport is used by Web and Desktop.
 * No provider transport, polling loop, credentials or execution state lives here.
 * setup omits instanceId for first creation and returns the server's instance
 * receipt; reconnect callers pass that persisted ID without generating another.
 */
export function createHarnessClient(options: AppServerClientOptions): HarnessClient {
  return {
    setup: (params) => requestAppServerOperation(options, { method: "harness/setup", params }, AppServerResultSchemas["harness/setup"]),
    status: (params) => requestAppServerOperation(options, { method: "harness/status", params }, AppServerResultSchemas["harness/status"]),
    models: (params) => requestAppServerOperation(options, { method: "harness/models", params }, AppServerResultSchemas["harness/models"]),
    readSelection: (params) => requestAppServerOperation(options, { method: "harness/selection/read", params }, AppServerResultSchemas["harness/selection/read"]),
    select: (params) => requestAppServerOperation(options, { method: "harness/selection/select", params }, AppServerResultSchemas["harness/selection/select"]),
  };
}
type HarnessMethod = Extract<AppServerRequest["method"], `harness/${string}`>;
type HarnessOperation<Method extends HarnessMethod> = (
  params: Extract<AppServerRequest, { method: Method }>["params"],
) => Promise<Extract<AppServerSuccessResponse, { method: Method }>["result"]>;

/** Client signatures follow the public wire contract, never server composition. */
export type HarnessClient = {
  setup: HarnessOperation<"harness/setup">;
  status: HarnessOperation<"harness/status">;
  models: HarnessOperation<"harness/models">;
  readSelection: HarnessOperation<"harness/selection/read">;
  select: HarnessOperation<"harness/selection/select">;
};
