import { z } from "zod";
import {
  ReasoningEffortSchema,
  type BYOKDiscoveredProviderModel,
  type ReasoningEffort,
} from "@repo/shared-types";
import type { ProviderModelCatalogPort } from "../ProviderModelCatalogPort";
import type {
  ProviderModelCredentialContext,
  ProviderModelFetchPageInput,
  ProviderModelPageFetchResult,
} from "../types";
import {
  ProviderModelDiscoveryApiError,
  ProviderModelNormalizationError,
} from "../errors";

const OpenAICompatibleModelsSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      reasoning_efforts: z.array(z.string().min(1)).optional(),
      reasoningEfforts: z.array(z.string().min(1)).optional(),
      supported_reasoning_efforts: z.array(z.string().min(1)).optional(),
      supportedReasoningEfforts: z.array(z.string().min(1)).optional(),
      supported_parameters: supportedParametersSchema().optional(),
      efforts: z.array(z.string().min(1)).optional(),
      reasoning: z
        .union([
          z.array(z.string().min(1)),
          z.object({
            efforts: z.array(z.string().min(1)).optional(),
            levels: z.array(z.string().min(1)).optional(),
            variants: z.record(z.unknown()).optional(),
          }),
        ])
        .optional(),
      settings: z
        .object({
          reasoning_efforts: z.array(z.string().min(1)).optional(),
          reasoningEfforts: z.array(z.string().min(1)).optional(),
          efforts: z.array(z.string().min(1)).optional(),
        })
        .optional(),
      variants: z.record(z.unknown()).optional(),
      capabilities: z
        .object({
          reasoning_efforts: z.array(z.string().min(1)).optional(),
          reasoningEfforts: z.array(z.string().min(1)).optional(),
          supported_reasoning_efforts: z.array(z.string().min(1)).optional(),
          supportedReasoningEfforts: z.array(z.string().min(1)).optional(),
          supported_parameters: supportedParametersSchema().optional(),
          reasoning: z
            .union([
              z.array(z.string().min(1)),
              z.object({
                efforts: z.array(z.string().min(1)).optional(),
                levels: z.array(z.string().min(1)).optional(),
                variants: z.record(z.unknown()).optional(),
              }),
            ])
            .optional(),
          settings: z
            .object({
              reasoning_efforts: z.array(z.string().min(1)).optional(),
              reasoningEfforts: z.array(z.string().min(1)).optional(),
              efforts: z.array(z.string().min(1)).optional(),
            })
            .optional(),
        })
        .optional(),
    }),
  ),
});
const OPENAI_COMPATIBLE_FETCH_TIMEOUT_MS = 15_000;

export class OpenAICompatibleModelCatalogAdapter implements ProviderModelCatalogPort {
  constructor(
    private readonly providerId: string,
    private readonly modelsEndpoint: string,
  ) {}

  async fetchAll(
    providerId: string,
    credentialContext: ProviderModelCredentialContext,
  ): Promise<BYOKDiscoveredProviderModel[]> {
    if (providerId !== this.providerId) {
      throw new ProviderModelDiscoveryApiError(
        `Adapter for "${this.providerId}" received unsupported provider "${providerId}".`,
        { status: 400, retryable: false },
      );
    }
    const response = await requestOpenAICompatibleModels(
      this.providerId,
      this.modelsEndpoint,
      credentialContext.apiKey,
    );
    const payload = await parseOpenAICompatibleModels(
      response,
      this.providerId,
    );
    return payload.data.map((item) => toDiscoveredModel(this.providerId, item));
  }

  async fetchPage(
    input: ProviderModelFetchPageInput,
  ): Promise<ProviderModelPageFetchResult> {
    const offset = parseCursor(input.cursor);
    const models = await this.fetchAll(
      input.providerId,
      input.credentialContext,
    );
    const nextOffset = offset + input.limit;
    return {
      providerId: input.providerId,
      models: models.slice(offset, nextOffset),
      nextCursor: nextOffset < models.length ? String(nextOffset) : undefined,
      fetchedAt: new Date().toISOString(),
      source: "provider_api",
    };
  }
}

function toDiscoveredModel(
  providerId: string,
  model: z.infer<typeof OpenAICompatibleModelsSchema>["data"][number],
): BYOKDiscoveredProviderModel {
  const reasoningEfforts = normalizeReasoningEfforts(
    model.reasoning_efforts ??
      model.reasoningEfforts ??
      model.supported_reasoning_efforts ??
      model.supportedReasoningEfforts ??
      supportedParameterEfforts(model.supported_parameters) ??
      model.efforts ??
      reasoningArray(model.reasoning) ??
      reasoningObject(model.reasoning)?.efforts ??
      reasoningObject(model.reasoning)?.levels ??
      model.settings?.reasoning_efforts ??
      model.settings?.reasoningEfforts ??
      model.settings?.efforts ??
      model.capabilities?.reasoning_efforts ??
      model.capabilities?.reasoningEfforts ??
      model.capabilities?.supported_reasoning_efforts ??
      model.capabilities?.supportedReasoningEfforts ??
      supportedParameterEfforts(model.capabilities?.supported_parameters) ??
      reasoningArray(model.capabilities?.reasoning) ??
      reasoningObject(model.capabilities?.reasoning)?.efforts ??
      reasoningObject(model.capabilities?.reasoning)?.levels ??
      model.capabilities?.settings?.reasoning_efforts ??
      model.capabilities?.settings?.reasoningEfforts ??
      model.capabilities?.settings?.efforts ??
      variantKeys(reasoningObject(model.reasoning)?.variants) ??
      variantKeys(reasoningObject(model.capabilities?.reasoning)?.variants) ??
      variantKeys(model.variants),
  );
  return {
    id: model.id,
    name: model.id,
    providerId,
    ...(reasoningEfforts.length > 0
      ? {
          capabilities: {
            supportsReasoning: true,
            reasoningEfforts,
          },
          capabilityMetadata: {
            source: "provider_api" as const,
            confidence: "confirmed" as const,
          },
        }
      : {}),
  };
}

function normalizeReasoningEfforts(
  efforts: readonly string[] | undefined,
): ReasoningEffort[] {
  if (!efforts) {
    return [];
  }
  return Array.from(
    new Set(
      efforts.filter(
        (effort): effort is ReasoningEffort =>
          ReasoningEffortSchema.safeParse(effort).success,
      ),
    ),
  );
}

function supportedParametersSchema() {
  return z.union([
    z.array(z.string().min(1)),
    z.object({
      reasoning_effort: z.array(z.string().min(1)).optional(),
      reasoningEffort: z.array(z.string().min(1)).optional(),
      reasoning_efforts: z.array(z.string().min(1)).optional(),
      reasoningEfforts: z.array(z.string().min(1)).optional(),
    }),
  ]);
}

function supportedParameterEfforts(
  parameters:
    | readonly string[]
    | {
        reasoning_effort?: string[];
        reasoningEffort?: string[];
        reasoning_efforts?: string[];
        reasoningEfforts?: string[];
      }
    | undefined,
): readonly string[] | undefined {
  if (!parameters) return undefined;
  if (Array.isArray(parameters)) {
    const efforts = parameters.flatMap((parameter) => {
      const match = /^(?:reasoning_effort|reasoningEffort)[:=](.+)$/.exec(
        parameter,
      );
      return match?.[1] ? [match[1]] : [];
    });
    return efforts.length > 0 ? efforts : undefined;
  }
  const object = parameters as Exclude<typeof parameters, readonly string[]>;
  return (
    object.reasoning_effort ??
    object.reasoningEffort ??
    object.reasoning_efforts ??
    object.reasoningEfforts
  );
}

function variantKeys(
  variants: Record<string, unknown> | undefined,
): string[] | undefined {
  const keys = variants ? Object.keys(variants) : [];
  return keys.length > 0 ? keys : undefined;
}

type ReasoningMetadata = {
  efforts?: string[];
  levels?: string[];
  variants?: Record<string, unknown>;
};

function reasoningArray(
  reasoning: readonly string[] | ReasoningMetadata | undefined,
): readonly string[] | undefined {
  return Array.isArray(reasoning) ? reasoning : undefined;
}

function reasoningObject(
  reasoning: readonly string[] | ReasoningMetadata | undefined,
): ReasoningMetadata | undefined {
  return reasoning && !Array.isArray(reasoning)
    ? (reasoning as ReasoningMetadata)
    : undefined;
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) {
    return 0;
  }
  const parsed = Number(cursor);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ProviderModelDiscoveryApiError(
      `Invalid pagination cursor "${cursor}".`,
      { status: 400, retryable: false },
    );
  }
  return parsed;
}

async function requestOpenAICompatibleModels(
  providerId: string,
  modelsEndpoint: string,
  apiKey: string,
): Promise<Response> {
  const abortController = new AbortController();
  const timeoutId = setTimeout(
    () => abortController.abort(),
    OPENAI_COMPATIBLE_FETCH_TIMEOUT_MS,
  );
  let response: Response;
  try {
    response = await fetch(modelsEndpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: abortController.signal,
    });
  } catch (error) {
    clearTimeout(timeoutId);
    if (isAbortError(error)) {
      throw new ProviderModelDiscoveryApiError(
        `${providerId} models request timed out.`,
        { status: 504, retryable: true },
      );
    }
    throw new ProviderModelDiscoveryApiError(
      `${providerId} models request failed due to network error: ${toErrorMessage(error)}`,
      { retryable: true },
    );
  }
  clearTimeout(timeoutId);

  if (!response.ok) {
    let errorDetail = "";
    try {
      const errorBody = (await response.clone().json()) as
        | {
            error?: { message?: string };
          }
        | undefined;
      if (errorBody?.error?.message) {
        errorDetail = ` - ${errorBody.error.message}`;
      }
    } catch {
      /* ignore parse errors */
    }
    const isAuthError = response.status === 401 || response.status === 403;
    throw new ProviderModelDiscoveryApiError(
      `${providerId} models request failed with status ${response.status}${errorDetail}`,
      {
        status: response.status,
        retryable: response.status >= 500 && !isAuthError,
      },
    );
  }
  return response;
}

async function parseOpenAICompatibleModels(
  response: Response,
  providerId: string,
): Promise<z.infer<typeof OpenAICompatibleModelsSchema>> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new ProviderModelDiscoveryApiError(
      `${providerId} models response body was not valid JSON: ${toErrorMessage(error)}`,
      { retryable: false },
    );
  }

  const parsed = OpenAICompatibleModelsSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ProviderModelNormalizationError(
      `${providerId} models response failed schema validation.`,
    );
  }
  return parsed.data;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "unknown_error";
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  return error instanceof Error && error.name === "AbortError";
}
