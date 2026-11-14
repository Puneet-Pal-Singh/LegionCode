import { RuntimeCredentialReferenceSchema, ProviderIdSchema, ProviderConnectionConfigSchema, type ProviderId, type RuntimeCredentialReference } from "@repo/shared-types";
import { z } from "zod";

// Private main <-> utility-process messages. Never sent over renderer IPC or HTTP.
export { RuntimeCredentialReferenceSchema, type RuntimeCredentialReference } from "@repo/shared-types";
const request = z.object({ type: z.literal("runtime-credential-request"), requestId: z.string().uuid(), providerId: ProviderIdSchema });
const response = z.object({ type: z.literal("runtime-credential-response"), requestId: z.string().uuid(), providerId: ProviderIdSchema });
const credential = z.object({ apiKey: z.string().min(1).max(4_096), connectionConfig: ProviderConnectionConfigSchema.optional() }).strict().nullable();
export const RuntimeCredentialRequestSchema = z.discriminatedUnion("purpose", [
  request.extend({ purpose: z.literal("discovery") }).strict(),
  request.extend({ purpose: z.literal("capture") }).strict(),
  request.extend({ purpose: z.literal("acquire"), reference: RuntimeCredentialReferenceSchema }).strict(),
]);
export const RuntimeCredentialResponseSchema = z.discriminatedUnion("purpose", [
  response.extend({ purpose: z.literal("discovery"), credential }).strict(),
  response.extend({ purpose: z.literal("capture"), reference: RuntimeCredentialReferenceSchema.nullable() }).strict(),
  response.extend({ purpose: z.literal("acquire"), reference: RuntimeCredentialReferenceSchema, credential }).strict(),
]);
export const RuntimeCredentialCancelSchema = z.object({
  type: z.literal("runtime-credential-cancel"), requestId: z.string().uuid(), providerId: ProviderIdSchema,
  purpose: z.enum(["discovery", "capture", "acquire"]), reference: RuntimeCredentialReferenceSchema.optional(),
}).strict();
export type RuntimeCredentialRequest = z.infer<typeof RuntimeCredentialRequestSchema>;
export type RuntimeCredentialResponse = z.infer<typeof RuntimeCredentialResponseSchema>;
export type RuntimeCredentialCancel = z.infer<typeof RuntimeCredentialCancelSchema>;
export type RuntimeProviderCredential = NonNullable<Extract<RuntimeCredentialResponse, { purpose: "acquire" }>["credential"]>;
export function sameRuntimeCredentialReference(left: RuntimeCredentialReference, right: RuntimeCredentialReference): boolean {
  return left.providerId === right.providerId && left.connectionId === right.connectionId &&
    left.ownerGeneration === right.ownerGeneration && left.tokenMaterialVersion === right.tokenMaterialVersion;
}
/** Main/supervisor-only lease. Never serialize the predicate or this wrapper. */
export type RuntimeCredentialLease = {
  readonly credential: RuntimeProviderCredential | null;
  readonly reference?: RuntimeCredentialReference;
  readonly canDeliver: () => boolean;
};

export class RuntimeCredentialClient {
  private closed = false;
  private readonly pending = new Map<string, {
    request: RuntimeCredentialRequest;
    resolve: (response: RuntimeCredentialResponse) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    signal?: AbortSignal;
    abort: () => void;
  }>();

  constructor(private readonly postMessage: (message: RuntimeCredentialRequest | RuntimeCredentialCancel) => void) {}

  /** Discovery only. Native attempt execution must use its captured exact reference. */
  async resolveRuntimeCredential(providerId: ProviderId, signal?: AbortSignal): Promise<RuntimeProviderCredential | null> {
    const result = await this.send({ type: "runtime-credential-request", purpose: "discovery", requestId: crypto.randomUUID(), providerId }, signal);
    if (result.purpose !== "discovery") throw new Error("Protected provider credential purpose did not match");
    return result.credential;
  }

  async captureRuntimeCredentialReference(providerId: ProviderId, signal?: AbortSignal): Promise<RuntimeCredentialReference | null> {
    const result = await this.send({ type: "runtime-credential-request", purpose: "capture", requestId: crypto.randomUUID(), providerId }, signal);
    if (result.purpose !== "capture") throw new Error("Protected provider credential purpose did not match");
    return result.reference;
  }

  async acquireRuntimeCredential(expectedRef: RuntimeCredentialReference, signal?: AbortSignal): Promise<RuntimeProviderCredential | null> {
    const reference = RuntimeCredentialReferenceSchema.parse(expectedRef);
    const result = await this.send({ type: "runtime-credential-request", purpose: "acquire", requestId: crypto.randomUUID(), providerId: reference.providerId, reference }, signal);
    if (result.purpose !== "acquire") throw new Error("Protected provider credential purpose did not match");
    return result.credential;
  }

  private send(value: RuntimeCredentialRequest, signal?: AbortSignal): Promise<RuntimeCredentialResponse> {
    if (signal?.aborted) return Promise.reject(new Error("Protected provider credential request was aborted"));
    if (this.closed || this.pending.size >= 32) return Promise.reject(new Error("Protected provider credential channel is unavailable"));
    const request = RuntimeCredentialRequestSchema.parse(value);
    return new Promise((resolve, reject) => {
      const cancel = () => {
        try { this.postMessage({ type: "runtime-credential-cancel", requestId: request.requestId,
          providerId: request.providerId, purpose: request.purpose,
          ...(request.purpose === "acquire" ? { reference: request.reference } : {}) }); }
        catch { /* Cancellation delivery is not a closure receipt. */ }
      };
      const finish = (message: string) => {
        const pending = this.pending.get(request.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(request.requestId);
        signal?.removeEventListener("abort", abort);
        cancel();
        reject(new Error(message));
      };
      const abort = () => finish("Protected provider credential request was aborted");
      const timer = setTimeout(() => finish("Protected provider credential delivery timed out"), 10_000);
      this.pending.set(request.requestId, { request, resolve, reject, timer, signal, abort });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      try { this.postMessage(request); } catch { finish("Protected provider credential delivery is unavailable"); }
    });
  }

  handleMessage(value: unknown): boolean {
    const parsed = RuntimeCredentialResponseSchema.safeParse(value);
    if (!parsed.success) return false;
    const response = parsed.data;
    const pending = this.pending.get(response.requestId);
    if (!pending) return true;
    this.pending.delete(response.requestId);
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener("abort", pending.abort);
    const request = pending.request;
    const matchingReference = request.purpose !== "acquire" || (response.purpose === "acquire" &&
      sameRuntimeCredentialReference(request.reference, response.reference));
    const matchingProvider = response.providerId === request.providerId &&
      (!("reference" in response) || response.reference === null || response.reference.providerId === request.providerId) &&
      (!("credential" in response) || !response.credential?.connectionConfig || response.credential.connectionConfig.providerId === request.providerId);
    if (this.closed || pending.signal?.aborted || response.purpose !== request.purpose || !matchingProvider || !matchingReference) {
      pending.reject(new Error("Protected provider credential scope did not match"));
    } else pending.resolve(response);
    return true;
  }

  close(): void {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener("abort", pending.abort);
      try { this.postMessage({ type: "runtime-credential-cancel", requestId: pending.request.requestId,
        providerId: pending.request.providerId, purpose: pending.request.purpose,
        ...(pending.request.purpose === "acquire" ? { reference: pending.request.reference } : {}) }); }
      catch { /* Main retains the original lookup until it actually settles. */ }
      pending.reject(new Error("Protected provider credential channel closed"));
    }
    this.pending.clear();
  }
}
