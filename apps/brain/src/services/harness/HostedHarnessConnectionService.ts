import type { HarnessOperations } from "@legioncode/app-server/server";
import { AppServerOperationError } from "@legioncode/app-server/server";
import {
  HarnessInstanceStatusSchema, HarnessModelsResponseSchema,
  HarnessSelectionResponseSchema, HarnessSetupResponseSchema, HarnessStatusResponseSchema,
  type HarnessInstanceStatus,
} from "@repo/platform-protocol";
import type { StoredHarnessInstance } from "@repo/persistence";
import type { HostedHarnessOperationContext } from "../../integration/app-server/HostedHarnessOperations";
import type { HostedHarnessControlPlane, HostedHarnessMetadataTransaction } from "./PostgresHostedHarnessControlPlane";

type ContextualOperations = {
  [Method in keyof HarnessOperations]: (context: HostedHarnessOperationContext, input: Parameters<HarnessOperations[Method]>[0]) => ReturnType<HarnessOperations[Method]>;
};

/** Configured metadata only. Account, model catalog and host observations have
 * not been supplied, so this consumer cannot attest readiness or launch work. */
export function createHostedHarnessConnectionService(controlPlane: HostedHarnessControlPlane): ContextualOperations {
  const scope = (context: HostedHarnessOperationContext) => ({
    userId: context.userId, workspaceId: context.workspaceId, environmentId: context.environmentId,
  });
  const status = async (ports: HostedHarnessMetadataTransaction, stored: StoredHarnessInstance): Promise<HarnessInstanceStatus> => {
    const connection = await ports.connection(stored.connectionId);
    const connected = connection !== null && connection.ownerGeneration === stored.authOwnerGeneration;
    return HarnessInstanceStatusSchema.parse({
      workspaceId: stored.workspaceId, environmentId: stored.environmentId, instanceId: stored.instanceId,
      harness: stored.harness, connectionId: stored.connectionId, accountLabel: null, usage: null,
      state: connected ? "unavailable" : "reauthentication_required",
      reason: connected ? "Hosted account and execution boundary have not been verified" : "Selected connection is unavailable",
      capabilities: { approvals: false, questions: false, steer: false, resume: false, fork: false,
        images: false, terminal: false, contextTelemetry: false, accountQuota: false, experimental: false },
      runtimeVersion: null, protocolVersion: null, observedAt: new Date().toISOString(),
    });
  };
  return {
    setup: (context, params) => controlPlane.within(context, async (ports) => {
      const metadata = await ports.connection(params.connectionId);
      if (!metadata) throw new AppServerOperationError(404, "not_found", "Selected harness connection was not found");
      const stored = await ports.repository.setupInstance(scope(context), params, metadata);
      return HarnessSetupResponseSchema.parse({ instance: await status(ports, stored) });
    }),
    status: (context) => controlPlane.within(context, async (ports) => {
      const instances = await ports.repository.listInstances(scope(context));
      return HarnessStatusResponseSchema.parse({ instances: await Promise.all(instances.map((instance) => status(ports, instance))) });
    }),
    models: (context, params) => controlPlane.within(context, async (ports) => {
      const stored = await ports.repository.readInstance(scope(context), params.instanceId);
      if (!stored || stored.connectionId !== params.connectionId)
        throw new AppServerOperationError(404, "not_found", "Configured harness instance was not found");
      await status(ports, stored);
      return HarnessModelsResponseSchema.parse({ ...params, models: [], availability: "unavailable",
        reason: "A supported hosted harness model catalog is not connected", observedAt: new Date().toISOString() });
    }),
    readSelection: (context, params) => controlPlane.within(context, async (ports) =>
      HarnessSelectionResponseSchema.parse(await ports.repository.readSelection(scope(context), params))),
    select: (context, params) => controlPlane.within(context, async (ports) => {
      const saved = await ports.repository.readSelectionReceipt(scope(context), params);
      if (saved) return HarnessSelectionResponseSchema.parse(saved);
      if (params.selection) {
        const stored = await ports.repository.readInstance(scope(context), params.selection.instanceId);
        if (!stored || stored.harness !== params.selection.harness || stored.connectionId !== params.selection.connectionId)
          throw new AppServerOperationError(409, "invalid_request", "Selected harness instance does not match");
        const connection = await ports.connection(stored.connectionId);
        if (!connection || connection.ownerGeneration !== stored.authOwnerGeneration)
          throw new AppServerOperationError(503, "server_unavailable", "Selected harness connection is unavailable");
      }
      return HarnessSelectionResponseSchema.parse(await ports.repository.select(scope(context), params));
    }),
  };
}
