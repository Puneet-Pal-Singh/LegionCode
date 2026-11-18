import {
  snapshotNativeSandboxPhysicalBinding,
  type NativeSandboxPhysicalBinding,
} from "@repo/worker-protocol/private/native-sandbox-binding";
import {
  createSandboxId,
  type SandboxExecutionLease,
} from "../ports/SandboxExecutionLease";
import type { NativeSandbox } from "./NativeSandbox";

type OriginalLease = Pick<
  SandboxExecutionLease,
  "sandboxId" | "workspaceScope" | "generation"
>;
type NativeNamespace = DurableObjectNamespace<NativeSandbox>;

/** Called BEFORE physical acquisition. This computes only canonical names and
 * actual namespace identity; the caller persists it before any creator effects.
 * No expected image pin or profile label substitutes for runtime evidence. */
export async function selectNativeSandboxBinding(
  namespace: NativeNamespace | undefined,
  lease: OriginalLease,
): Promise<NativeSandboxPhysicalBinding> {
  if (!namespace) throw unavailable();
  const original = snapshotLease(lease);
  const sandboxId = await canonicalSandboxId(original);
  return snapshotNativeSandboxPhysicalBinding({
    version: 1,
    backend: "cloudflareSandbox",
    binding: "NativeSandbox",
    profile: "basic",
    schedulingPolicy: "default",
    sandboxObjectId: namespace.idFromName(sandboxId).toString(),
  });
}

/** Resolve only the original namespace reference. Missing/different bindings
 * never rebind or fall back to the legacy Sandbox namespace. In particular,
 * getSandbox() is deliberately not used here: its SDK configuration RPC would
 * introduce an effect before the original owner explicitly dispatches one. */
export async function resolveNativeSandbox(
  namespace: NativeNamespace | undefined,
  lease: OriginalLease,
  storedBinding: unknown,
): Promise<DurableObjectStub<NativeSandbox>> {
  const binding = snapshotNativeSandboxPhysicalBinding(storedBinding);
  if (!namespace) throw unavailable();
  const original = snapshotLease(lease);
  const sandboxId = await canonicalSandboxId(original);
  const objectId = namespace.idFromName(sandboxId);
  if (objectId.toString() !== binding.sandboxObjectId) throw unavailable();
  // No await or alternate namespace between identity comparison and reference.
  return namespace.get(objectId);
}

function snapshotLease(lease: OriginalLease) {
  const sandboxId = lease.sandboxId;
  const generation = lease.generation;
  const workspaceId = lease.workspaceScope.workspaceId;
  const runAttemptId = lease.workspaceScope.runAttemptId;
  if (
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    ![sandboxId, workspaceId, runAttemptId].every(
      (value) =>
        typeof value === "string" && value.length > 0 && value.length <= 256,
    )
  )
    throw unavailable();
  return Object.freeze({ sandboxId, generation, workspaceId, runAttemptId });
}

async function canonicalSandboxId(
  original: ReturnType<typeof snapshotLease>,
): Promise<string> {
  // Reuse the existing generator. Its lowercase sb-<60 hex> names are unchanged
  // by pinned SDK0.12.3 sanitizeSandboxId and either normalizeId setting. Never
  // duplicate the vendor parser or normalize/rebind a stored logical name.
  const expected = await createSandboxId(
    original.workspaceId,
    original.runAttemptId,
    original.generation,
  );
  if (original.sandboxId !== expected) throw unavailable();
  return expected;
}

function unavailable(): Error {
  return new Error("NATIVE_SANDBOX_ORIGINAL_BINDING_UNAVAILABLE");
}
