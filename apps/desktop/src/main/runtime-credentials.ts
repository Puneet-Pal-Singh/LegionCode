import { ProviderIdSchema, ProviderConnectionConfigSchema, type ProviderId } from "@repo/shared-types";
import { z } from "zod";

// Private main <-> utility-process messages. Never sent over renderer IPC or HTTP.
export const RuntimeCredentialRequestSchema = z.object({
  type: z.literal("runtime-credential-request"),
  requestId: z.string().uuid(),
  providerId: ProviderIdSchema,
}).strict();
export const RuntimeCredentialResponseSchema = z.object({
  type: z.literal("runtime-credential-response"),
  requestId: z.string().uuid(),
  providerId: ProviderIdSchema,
  credential: z.object({
    apiKey: z.string().min(1).max(4_096),
    connectionConfig: ProviderConnectionConfigSchema.optional(),
  }).strict().nullable(),
}).strict();
export type RuntimeCredentialRequest = z.infer<typeof RuntimeCredentialRequestSchema>;
export type RuntimeCredentialResponse = z.infer<typeof RuntimeCredentialResponseSchema>;
export type RuntimeProviderCredential = NonNullable<RuntimeCredentialResponse["credential"]>;

/** Main/supervisor-only lease. Never serialize the predicate or this wrapper. */
export type RuntimeCredentialLease = {
  readonly credential: RuntimeProviderCredential | null;
  readonly isCurrent: () => boolean;
};

export class RuntimeCredentialClient {
  private closed = false;
  private readonly pending = new Map<string, {
    providerId: ProviderId;
    resolve: (credential: RuntimeProviderCredential | null) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    signal?: AbortSignal;
    abort?: () => void;
  }>();

  constructor(private readonly postMessage: (message: RuntimeCredentialRequest) => void) {}

  resolveRuntimeCredential(providerId: ProviderId, signal?: AbortSignal): Promise<RuntimeProviderCredential | null> {
    if (signal?.aborted) return Promise.reject(new Error("Protected provider credential request was aborted"));
    if (this.closed || this.pending.size >= 32) {
      return Promise.reject(new Error("Protected provider credential channel is unavailable"));
    }
    const request = RuntimeCredentialRequestSchema.parse({
      type: "runtime-credential-request", requestId: crypto.randomUUID(), providerId,
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
      this.pending.set(request.requestId, { providerId, resolve, reject, timer, signal, abort });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      try { this.postMessage(request); } catch {
        clearTimeout(timer);
        this.pending.delete(request.requestId);
        signal?.removeEventListener("abort", abort);
        reject(new Error("Protected provider credential delivery is unavailable"));
      }
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
    if (pending.abort) pending.signal?.removeEventListener("abort", pending.abort);
    if (response.providerId !== pending.providerId ||
        (response.credential?.connectionConfig && response.credential.connectionConfig.providerId !== pending.providerId)) {
      pending.reject(new Error("Protected provider credential scope did not match"));
    } else {
      pending.resolve(response.credential);
    }
    return true;
  }

  close(): void {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      if (pending.abort) pending.signal?.removeEventListener("abort", pending.abort);
      pending.reject(new Error("Protected provider credential channel closed"));
    }
    this.pending.clear();
  }
}
