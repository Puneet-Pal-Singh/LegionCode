import {
  RuntimeCredentialReferenceSchema,
  type ProviderId,
  type RuntimeCredentialReference,
} from "@repo/shared-types";
import type { TurnAdmission } from "@repo/platform-protocol";
import type { LocalPersistence } from "@repo/event-store/local";
import type {
  ProtectedProviderCredential,
  ProtectedProviderInferenceOptions,
} from "@legioncode/execution-engine/runtime/provider/ProtectedProviderInference";
import { AppServerOperationError } from "./server.js";

export interface LocalNativeRuntimeCredentialPorts {
  readonly captureRuntimeCredentialReference: (
    providerId: ProviderId,
    signal?: AbortSignal,
  ) => Promise<RuntimeCredentialReference | null>;
  readonly acquireRuntimeCredential: (
    reference: RuntimeCredentialReference,
    signal?: AbortSignal,
  ) => Promise<ProtectedProviderCredential | null>;
}

/** Private admission port; callers persist only this nonsecret reference. */
export interface LocalNativeCredentialRuntime {
  captureRuntimeCredentialReference(
    providerId: ProviderId,
    signal?: AbortSignal,
  ): Promise<Readonly<RuntimeCredentialReference>>;
}

export function requireLocalNativeCredentialReference(
  value: unknown,
  providerId: string,
): Readonly<RuntimeCredentialReference> {
  const reference = RuntimeCredentialReferenceSchema.safeParse(value);
  if (!reference.success || reference.data.providerId !== providerId) {
    throw new AppServerOperationError(
      409, "conflict", "The admitted Native provider credential is unavailable",
      "local_credential_binding_unavailable", false,
    );
  }
  return Object.freeze(reference.data);
}

export async function readLocalNativeCredentialReference(
  admissions: Pick<LocalPersistence["turnAdmissions"], "readCredentialAcquisition">,
  admission: TurnAdmission,
): Promise<Readonly<RuntimeCredentialReference>> {
  return requireLocalNativeCredentialReference(await admissions.readCredentialAcquisition({
    userId: admission.run.userId, workspaceId: admission.run.workspaceId,
    threadId: admission.run.threadId, runId: admission.run.id,
    turnId: admission.turn.id, runAttemptId: admission.runAttemptId,
  }), admission.run.providerId);
}

/** Every request re-acquires this exact connection and both captured epochs. */
export function createLocalNativeCredentialResolver(
  reference: RuntimeCredentialReference,
  acquire: LocalNativeRuntimeCredentialPorts["acquireRuntimeCredential"],
): ProtectedProviderInferenceOptions["resolveCredential"] {
  const captured = requireLocalNativeCredentialReference(reference, reference.providerId);
  return async (providerId, signal) => {
    signal?.throwIfAborted();
    if (providerId !== captured.providerId) {
      throw new AppServerOperationError(409, "conflict", "Native inference cannot change its admitted provider", "local_credential_binding_unavailable", false);
    }
    const credential = await acquire(captured, signal);
    signal?.throwIfAborted();
    return credential;
  };
}
