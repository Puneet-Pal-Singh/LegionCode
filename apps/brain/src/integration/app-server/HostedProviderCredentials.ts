import type { AppServerComposition } from "@legioncode/app-server/server";
import type { Env } from "../../types/ai";
import { createHostedProviderOperation } from "./HostedProviderScope";
import {
  listProviderCredentials,
  connectProviderCredential,
  updateProviderCredential,
  disconnectProviderCredential,
  validateProviderCredential,
} from "./ProviderCredentialOperations";

/** Hosted credential intent delegates to the existing runtime owner. */
export function composeHostedProviderCredentials(
  request: Request,
  env: Env,
  userId: string,
): NonNullable<AppServerComposition["hostedProviderCredentialService"]> {
  const operation = createHostedProviderOperation(request, env, userId);
  return {
    list: (runId) =>
      operation(runId, (scope, id) =>
        listProviderCredentials(request, env, scope, id),
      ),
    connect: (runId, params) =>
      operation(runId, (scope, id) =>
        connectProviderCredential(request, env, scope, id, params),
      ),
    update: (runId, credentialId, params) =>
      operation(runId, (scope, id) =>
        updateProviderCredential(request, env, scope, id, credentialId, params),
      ),
    disconnect: (runId, credentialId) =>
      operation(runId, (scope, id) =>
        disconnectProviderCredential(request, env, scope, id, credentialId),
      ),
    validate: (runId, credentialId, params) =>
      operation(runId, (scope, id) =>
        validateProviderCredential(
          request,
          env,
          scope,
          id,
          credentialId,
          params,
        ),
      ),
  };
}
