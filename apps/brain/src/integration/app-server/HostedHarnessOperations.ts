import type { HarnessOperations } from "@legioncode/app-server/server";
import {
  HarnessSetupRequestSchema, HarnessStatusRequestSchema, HarnessModelsRequestSchema,
  HarnessSelectionReadRequestSchema, HarnessSelectRequestSchema,
} from "@repo/platform-protocol";
import type { Env } from "../../types/ai";
import { createHostedHarnessConnectionService } from "../../services/harness/HostedHarnessConnectionService";
import { createPostgresHostedHarnessControlPlane } from "../../services/harness/PostgresHostedHarnessControlPlane";

/** The controller supplies its authenticated principal; submitted scopes never
 * supply a user or establish the server's placement identity. */
export interface HostedHarnessOperationContext {
  readonly userId: string;
  readonly workspaceId: string;
  readonly environmentId: string;
  readonly signal: AbortSignal;
}

export function composeHostedHarnessOperations(
  request: Request,
  env: Env,
  userId: string,
  expectedEnvironmentId: string | null,
): HarnessOperations {
  const service = createHostedHarnessConnectionService(
    createPostgresHostedHarnessControlPlane(env, expectedEnvironmentId),
  );
  const context = (input: { workspaceId: string; environmentId: string }): HostedHarnessOperationContext =>
    Object.freeze({ userId, workspaceId: input.workspaceId, environmentId: input.environmentId, signal: request.signal });
  return {
    setup: (input) => { const params = HarnessSetupRequestSchema.parse(input); return service.setup(context(params), params); },
    status: (input) => { const params = HarnessStatusRequestSchema.parse(input); return service.status(context(params), params); },
    models: (input) => { const params = HarnessModelsRequestSchema.parse(input); return service.models(context(params), params); },
    readSelection: (input) => { const params = HarnessSelectionReadRequestSchema.parse(input); return service.readSelection(context(params), params); },
    select: (input) => { const params = HarnessSelectRequestSchema.parse(input); return service.select(context(params), params); },
  };
}
