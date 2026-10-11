import type { AppServerComposition } from "@legioncode/app-server/server";
import type { Env } from "../../types/ai";
import { createHostedProviderOperation } from "./HostedProviderScope";
import {
  readProviderPreferences,
  updateProviderPreferences,
  resolveProviderPreferences,
} from "./ProviderPreferenceOperations";

/** Authenticated intent; runtime preferences and policy retain ownership. */
export function composeHostedProviderPreferences(
  request: Request,
  env: Env,
  userId: string,
): NonNullable<AppServerComposition["hostedProviderPreferenceService"]> {
  const operation = createHostedProviderOperation(request, env, userId);
  return {
    read: (runId) =>
      operation(runId, (scope, id) =>
        readProviderPreferences(request, env, scope, id),
      ),
    update: (runId, params) =>
      operation(runId, (scope, id) =>
        updateProviderPreferences(request, env, scope, id, params),
      ),
    resolve: (runId, params) =>
      operation(runId, (scope, id) =>
        resolveProviderPreferences(request, env, scope, id, params),
      ),
  };
}
