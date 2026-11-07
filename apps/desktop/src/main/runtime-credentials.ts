import {
  CredentialAcquisitionSchema,
  RuntimeCredentialMaterialSchema,
  ProviderIdSchema,
  ProviderConnectionConfigSchema,
  type ProviderId,
} from "@repo/shared-types";
import { z } from "zod";
import { HarnessStartCommandSchema } from "@repo/worker-protocol";

// Private main <-> utility-process messages. Never sent over renderer IPC or HTTP.
export const NativeRuntimeCredentialRequestSchema = z
  .object({
    type: z.literal("runtime-credential-request"),
    requestId: z.string().uuid(),
    providerId: ProviderIdSchema,
  })
  .strict();
export const NativeRuntimeCredentialResponseSchema = z
  .object({
    type: z.literal("runtime-credential-response"),
    requestId: z.string().uuid(),
    providerId: ProviderIdSchema,
    credential: z
      .object({
        apiKey: z.string().min(1).max(4_096),
        connectionConfig: ProviderConnectionConfigSchema.optional(),
      })
      .strict()
      .nullable(),
  })
  .strict();
// Canonical command metadata only: never send prompt, root, snapshot or resume payload.
export const ExternalHarnessExecutionSchema =
  HarnessStartCommandSchema.unwrap().pick({
    mode: true,
    commandId: true,
    selection: true,
    leaseId: true,
  });
const ExternalHarnessOriginSchema = z
  .object({
    purpose: z.literal("external_harness"),
    requestId: z.string().uuid(),
    utilityProcessGeneration: z.number().int().safe().positive(),
    acquisition: CredentialAcquisitionSchema,
    execution: ExternalHarnessExecutionSchema,
  })
  .strict();
function validateHarnessOrigin(
  origin: z.infer<typeof ExternalHarnessOriginSchema>,
  context: z.RefinementCtx,
): void {
  const {
    acquisition,
    execution: { selection },
  } = origin;
  if (
    acquisition.userId !== selection.userId ||
    acquisition.connectionId !== selection.connectionId ||
    acquisition.ownerGeneration !== selection.authOwnerGeneration
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Credential acquisition scope does not match frozen selection",
    });
  }
}
export const ExternalHarnessCredentialRequestSchema =
  ExternalHarnessOriginSchema.extend({
    type: z.literal("runtime-credential-request"),
  })
    .strict()
    .superRefine(validateHarnessOrigin);
export const ExternalHarnessCredentialResultSchema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        status: z.literal("acquired"),
        material: RuntimeCredentialMaterialSchema,
      })
      .strict(),
    z
      .object({
        status: z.literal("unavailable"),
        code: z.enum(["stale_origin", "stale_acquisition", "unavailable"]),
      })
      .strict(),
  ],
);
export const ExternalHarnessCredentialResponseSchema =
  ExternalHarnessOriginSchema.extend({
    type: z.literal("runtime-credential-response"),
    result: ExternalHarnessCredentialResultSchema,
  })
    .strict()
    .superRefine(validateHarnessOrigin);
export const RuntimeCredentialRequestSchema = z.union([
  NativeRuntimeCredentialRequestSchema,
  ExternalHarnessCredentialRequestSchema,
]);
export const RuntimeCredentialResponseSchema = z.union([
  NativeRuntimeCredentialResponseSchema,
  ExternalHarnessCredentialResponseSchema,
]);
export type RuntimeCredentialRequest = z.infer<
  typeof RuntimeCredentialRequestSchema
>;
export type RuntimeCredentialResponse = z.infer<
  typeof RuntimeCredentialResponseSchema
>;
export type ExternalHarnessCredentialRequest = z.infer<
  typeof ExternalHarnessCredentialRequestSchema
>;
export type ExternalHarnessCredentialResult = z.infer<
  typeof ExternalHarnessCredentialResultSchema
>;
export type RuntimeProviderCredential = NonNullable<
  z.infer<typeof NativeRuntimeCredentialResponseSchema>["credential"]
>;

/** Private DI result. The predicate and wrapper never cross the process channel. */
export type ExternalHarnessCredentialLease = {
  readonly result: ExternalHarnessCredentialResult;
  readonly canDeliver: () => boolean;
};

/** Main/supervisor-only lease. Never serialize the predicate or this wrapper. */
export type RuntimeCredentialLease = {
  readonly credential: RuntimeProviderCredential | null;
  readonly canDeliver: () => boolean;
};

export class RuntimeCredentialClient {
  private closed = false;
  private readonly pending = new Map<
    string,
    {
      providerId: ProviderId;
      resolve: (credential: RuntimeProviderCredential | null) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      signal?: AbortSignal;
      abort?: () => void;
    }
  >();

  private readonly externalPending = new Map<
    string,
    {
      request: ExternalHarnessCredentialRequest;
      resolve: (result: ExternalHarnessCredentialResult) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      signal?: AbortSignal;
      abort: () => void;
    }
  >();

  constructor(
    private readonly postMessage: (message: RuntimeCredentialRequest) => void,
    private readonly utilityProcessGeneration?: number,
  ) {}

  resolveRuntimeCredential(
    providerId: ProviderId,
    signal?: AbortSignal,
  ): Promise<RuntimeProviderCredential | null> {
    if (signal?.aborted)
      return Promise.reject(
        new Error("Protected provider credential request was aborted"),
      );
    if (this.closed || this.pending.size + this.externalPending.size >= 32) {
      return Promise.reject(
        new Error("Protected provider credential channel is unavailable"),
      );
    }
    const request = NativeRuntimeCredentialRequestSchema.parse({
      type: "runtime-credential-request",
      requestId: crypto.randomUUID(),
      providerId,
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId);
        signal?.removeEventListener("abort", abort);
        reject(new Error("Protected provider credential delivery timed out"));
      }, 10_000);
      const abort = () => {
        clearTimeout(timer);
        this.pending.delete(request.requestId);
        signal?.removeEventListener("abort", abort);
        reject(new Error("Protected provider credential request was aborted"));
      };
      this.pending.set(request.requestId, {
        providerId,
        resolve,
        reject,
        timer,
        signal,
        abort,
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      try {
        this.postMessage(request);
      } catch {
        clearTimeout(timer);
        this.pending.delete(request.requestId);
        signal?.removeEventListener("abort", abort);
        reject(
          new Error("Protected provider credential delivery is unavailable"),
        );
      }
    });
  }

  handleMessage(value: unknown): boolean {
    const parsed = RuntimeCredentialResponseSchema.safeParse(value);
    if (!parsed.success) return false;
    const response = parsed.data;
    if ("purpose" in response) return this.handleExternalResponse(response);
    const pending = this.pending.get(response.requestId);
    if (!pending) return true;
    this.pending.delete(response.requestId);
    clearTimeout(pending.timer);
    if (pending.abort)
      pending.signal?.removeEventListener("abort", pending.abort);
    if (
      response.providerId !== pending.providerId ||
      (response.credential?.connectionConfig &&
        response.credential.connectionConfig.providerId !== pending.providerId)
    ) {
      pending.reject(
        new Error("Protected provider credential scope did not match"),
      );
    } else {
      pending.resolve(response.credential);
    }
    return true;
  }

  acquireExternalHarnessCredential(
    input: Pick<ExternalHarnessCredentialRequest, "acquisition" | "execution">,
    signal?: AbortSignal,
  ): Promise<ExternalHarnessCredentialResult> {
    const generation = this.utilityProcessGeneration;
    if (
      this.closed ||
      signal?.aborted ||
      generation === undefined ||
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      this.pending.size + this.externalPending.size >= 32
    ) {
      return Promise.reject(
        new Error("Protected harness credential channel is unavailable"),
      );
    }
    const request = ExternalHarnessCredentialRequestSchema.parse({
      ...input,
      type: "runtime-credential-request",
      purpose: "external_harness",
      requestId: crypto.randomUUID(),
      utilityProcessGeneration: generation,
    });
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.removeExternal(request.requestId);
        reject(new Error("Protected harness credential request was aborted"));
      };
      const timer = setTimeout(() => {
        this.removeExternal(request.requestId);
        reject(new Error("Protected harness credential delivery timed out"));
      }, 10_000);
      this.externalPending.set(request.requestId, {
        request,
        resolve,
        reject,
        timer,
        signal,
        abort,
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      try {
        this.postMessage(request);
      } catch {
        this.removeExternal(request.requestId);
        reject(
          new Error("Protected harness credential delivery is unavailable"),
        );
      }
    });
  }

  private removeExternal(requestId: string) {
    const pending = this.externalPending.get(requestId);
    if (!pending) return;
    this.externalPending.delete(requestId);
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener("abort", pending.abort);
    return pending;
  }

  private handleExternalResponse(
    response: z.infer<typeof ExternalHarnessCredentialResponseSchema>,
  ): boolean {
    const pending = this.removeExternal(response.requestId);
    if (!pending) return true;
    const origin = pending.request;
    if (
      origin.utilityProcessGeneration !== response.utilityProcessGeneration ||
      JSON.stringify(origin.acquisition) !==
        JSON.stringify(response.acquisition) ||
      JSON.stringify(origin.execution) !== JSON.stringify(response.execution)
    ) {
      pending.reject(
        new Error("Protected harness credential scope did not match"),
      );
    } else {
      pending.resolve(response.result);
    }
    return true;
  }

  close(): void {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      if (pending.abort)
        pending.signal?.removeEventListener("abort", pending.abort);
      pending.reject(new Error("Protected provider credential channel closed"));
    }
    this.pending.clear();
    for (const requestId of this.externalPending.keys()) {
      this.removeExternal(requestId)?.reject(
        new Error("Protected harness credential channel closed"),
      );
    }
  }
}
