import { z } from "zod";
import { snapshotNativeSandboxPhysicalBinding } from "@repo/worker-protocol/private/native-sandbox-binding";
import type { Env } from "../index";

const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const timestamp = z.string().max(64).datetime();
// The pinned provider CLI's image-name grammar, with bounded SHA-256 digests.
// Tags and bare names remain observations; no digest/provenance is inferred.
const imageComponent = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";
const imageName = `(?:${imageComponent}(?::[0-9]{1,5})?/)?${imageComponent}(?:/${imageComponent})*`;
const imageReference = new RegExp(
  `^${imageName}(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?(?:@sha256:[a-fA-F0-9]{64})?$`,
);
const resources = z
  .object({
    disk: z.number().finite().min(1).max(Number.MAX_SAFE_INTEGER),
    memory: z.number().finite().min(1).max(Number.MAX_SAFE_INTEGER),
    vcpu: z.number().finite().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const instance = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    application_id: identifier,
    image: z.string().min(1).max(2048).regex(imageReference),
    status: z
      .object({
        state: z.enum([
          "provisioning",
          "running",
          "failed",
          "stopping",
          "stopped",
          "unhealthy",
          "inactive",
          "unknown",
        ]),
        updated_at: timestamp,
        exit_code: z.number().int().safe().optional(),
      })
      .strict(),
    configuration: resources.optional(),
    started_at: timestamp.optional(),
    // Provider labels/location are validated but never retained as identity/proof.
    location: z
      .object({
        name: z.string().min(1).max(256),
        region: z.enum([
          "AFR",
          "APAC",
          "EEUR",
          "ENAM",
          "WNAM",
          "ME",
          "OC",
          "SAM",
          "WEUR",
        ]),
      })
      .strict()
      .optional(),
    name: z.string().max(1024).optional(),
  })
  .strict();
const responseSchema = z
  .object({
    success: z.literal(true),
    errors: z.array(z.unknown()).max(0),
    messages: z.array(z.unknown()).max(32),
    result: instance,
  })
  .strict();

/** Provider last-reported state only. It does not attest a guest boot or image
 * provenance and cannot activate Native execution or satisfy Ready evidence. */
export interface NativeContainerPlacementObservation {
  readonly version: 1;
  readonly kind: "cloudflare_container_placement_observation";
  readonly qualifying: false;
  readonly accountId: string;
  readonly applicationId: string;
  readonly actorId: string;
  readonly imageReference: string;
  readonly status: Readonly<z.infer<typeof instance>["status"]>;
  readonly configuration?: Readonly<z.infer<typeof resources>>;
  readonly startedAt?: string;
  readonly requestedAt: number;
  readonly completedAt: number;
}

/** The existing server Worker Env owns the read credential. No endpoint,
 * account, application or actor is selected by a request or guest label.
 * Least privilege for this GET is Workers Containers Read on the account. */
export class NativeContainerPlacementReader {
  readonly #token: string;
  readonly #accountId: string;
  readonly #applicationId: string;

  constructor(
    env: Pick<
      Env,
      | "NATIVE_PLACEMENT_READ_TOKEN"
      | "NATIVE_PLACEMENT_ACCOUNT_ID"
      | "NATIVE_PLACEMENT_APPLICATION_ID"
    >,
  ) {
    const token = env.NATIVE_PLACEMENT_READ_TOKEN;
    const accountId = env.NATIVE_PLACEMENT_ACCOUNT_ID;
    const applicationId = env.NATIVE_PLACEMENT_APPLICATION_ID;
    if (
      typeof token !== "string" ||
      !/^[\x21-\x7e]{1,4096}$/.test(token) ||
      typeof accountId !== "string" ||
      !/^[a-f0-9]{32}$/.test(accountId) ||
      typeof applicationId !== "string" ||
      !identifier.safeParse(applicationId).success
    ) {
      throw new Error("NATIVE_PLACEMENT_CONFIG_UNAVAILABLE");
    }
    this.#token = token;
    this.#accountId = accountId;
    this.#applicationId = applicationId;
  }

  async read(
    storedPhysicalBinding: unknown,
  ): Promise<NativeContainerPlacementObservation> {
    // Must be invoked inside the original command session's tracked operation.
    // Invalid physical metadata never becomes a raw actor lookup or fallback.
    const physical = snapshotNativeSandboxPhysicalBinding(
      storedPhysicalBinding,
    );
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.#accountId}/containers/applications/${encodeURIComponent(this.#applicationId)}/instances/${physical.sandboxObjectId}`;
    const requestedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.#token}`,
          Accept: "application/json",
        },
      });
      // Drain the ORIGINAL body on every HTTP result, including redirects and
      // errors. Oversized replies are discarded through EOF or abort settlement.
      // No Promise.race returns while the original fetch/read is still pending.
      const bytes = await drainOriginalBody(response);
      if (
        controller.signal.aborted ||
        response.status !== 200 ||
        response.redirected ||
        response.url !== url ||
        response.headers
          .get("content-type")
          ?.split(";")[0]
          ?.trim()
          .toLowerCase() !== "application/json"
      )
        throw unavailable();
      const parsed = responseSchema.parse(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
            bytes,
          ),
        ),
      ).result;
      if (
        parsed.id !== physical.sandboxObjectId ||
        parsed.application_id !== this.#applicationId ||
        controller.signal.aborted
      )
        throw unavailable();
      const observation: NativeContainerPlacementObservation = Object.freeze({
        version: 1,
        kind: "cloudflare_container_placement_observation",
        qualifying: false,
        accountId: this.#accountId,
        applicationId: parsed.application_id,
        actorId: parsed.id,
        imageReference: parsed.image,
        status: Object.freeze({ ...parsed.status }),
        ...(parsed.configuration
          ? { configuration: Object.freeze({ ...parsed.configuration }) }
          : {}),
        ...(parsed.started_at ? { startedAt: parsed.started_at } : {}),
        requestedAt,
        completedAt: Date.now(),
      });
      if (JSON.stringify(observation).includes(this.#token))
        throw unavailable();
      return observation;
    } catch {
      // Never propagate provider errors, raw replies, request headers or secrets.
      throw unavailable();
    } finally {
      clearTimeout(timer);
    }
  }
}

async function drainOriginalBody(response: Response): Promise<Uint8Array> {
  if (!response.body) throw unavailable();
  const reader = response.body.getReader();
  const retained = new Uint8Array(MAX_RESPONSE_BYTES);
  let size = 0;
  let oversized = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (oversized || value.byteLength > MAX_RESPONSE_BYTES - size) {
        oversized = true;
        continue;
      }
      retained.set(value, size);
      size += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (oversized || size === 0) throw unavailable();
  return retained.subarray(0, size);
}
function unavailable(): Error {
  return new Error("NATIVE_PLACEMENT_OBSERVATION_UNAVAILABLE");
}
