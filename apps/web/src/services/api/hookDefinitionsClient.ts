import { z } from "zod";
import { getBrainHttpBase } from "../../lib/platform-endpoints.js";

const WorkspaceIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);

const HookHandlerIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_.:-]{0,127}$/);
const HookEventNameSchema = z.enum([
  "SessionStart",
  "UserPromptSubmit",
  "PermissionRequest",
  "Stop",
]);
const HookSourceSchema = z.enum(["user", "project", "plugin"]);
const HookDefinitionSchema = z
  .object({
    handlerId: HookHandlerIdSchema,
    eventName: HookEventNameSchema,
    source: HookSourceSchema,
    displayName: z.string().min(1).max(120),
    enabled: z.boolean(),
    order: z.number().int().min(0).max(10_000),
    timeoutMs: z.number().int().min(50).max(30_000),
    configurationKey: z.string().min(1).max(256).nullable(),
  })
  .strict();

/** A narrow Web API facade over the server-owned hook-definition protocol. */
export type HookDefinition = z.infer<typeof HookDefinitionSchema>;

const HookDefinitionsResponseSchema = z
  .object({ hooks: z.array(HookDefinitionSchema) })
  .strict();
const HookDefinitionResponseSchema = z
  .object({ hook: HookDefinitionSchema })
  .strict();

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface HookDefinitionsClient {
  list(workspaceId: string, signal?: AbortSignal): Promise<HookDefinition[]>;
  update(
    workspaceId: string,
    definition: HookDefinition,
    signal?: AbortSignal,
  ): Promise<HookDefinition>;
  delete(
    workspaceId: string,
    handlerId: string,
    signal?: AbortSignal,
  ): Promise<void>;
}

/**
 * User-facing errors intentionally summarize the trusted server result rather
 * than echoing arbitrary response bodies into Settings.
 */
export class HookDefinitionsClientError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HookDefinitionsClientError";
  }
}

export function createHookDefinitionsClient(
  fetchImpl: FetchLike = fetch,
): HookDefinitionsClient {
  return new HttpHookDefinitionsClient(fetchImpl);
}

class HttpHookDefinitionsClient implements HookDefinitionsClient {
  constructor(private readonly fetchImpl: FetchLike) {}

  async list(
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<HookDefinition[]> {
    const response = await this.fetchImpl(buildHooksPath(workspaceId), {
      credentials: "include",
      signal,
    });
    await assertSuccessfulResponse(response);
    return HookDefinitionsResponseSchema.parse(await response.json()).hooks;
  }

  async update(
    workspaceId: string,
    definition: HookDefinition,
    signal?: AbortSignal,
  ): Promise<HookDefinition> {
    const parsedDefinition = HookDefinitionSchema.parse(definition);
    if (parsedDefinition.source !== "user") {
      throw new HookDefinitionsClientError(
        403,
        "Only user-managed hooks can be changed here.",
      );
    }

    const response = await this.fetchImpl(
      buildHooksPath(workspaceId, parsedDefinition.handlerId),
      {
        method: "PUT",
        credentials: "include",
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsedDefinition),
      },
    );
    await assertSuccessfulResponse(response);
    return HookDefinitionResponseSchema.parse(await response.json()).hook;
  }

  async delete(
    workspaceId: string,
    handlerId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.fetchImpl(buildHooksPath(workspaceId, handlerId), {
      method: "DELETE",
      credentials: "include",
      signal,
    });
    await assertSuccessfulResponse(response);
  }
}

function buildHooksPath(workspaceId: string, handlerId?: string): string {
  const parsedWorkspaceId = WorkspaceIdSchema.safeParse(workspaceId);
  if (!parsedWorkspaceId.success) {
    throw new HookDefinitionsClientError(400, "The active workspace is invalid.");
  }

  const basePath = `${getBrainHttpBase()}/api/workspaces/${encodeURIComponent(
    parsedWorkspaceId.data,
  )}/hooks`;
  if (!handlerId) {
    return basePath;
  }

  const parsedHandlerId = HookHandlerIdSchema.safeParse(handlerId);
  if (!parsedHandlerId.success) {
    throw new HookDefinitionsClientError(400, "The hook identifier is invalid.");
  }
  return `${basePath}/${encodeURIComponent(parsedHandlerId.data)}`;
}

async function assertSuccessfulResponse(response: Response): Promise<void> {
  if (response.ok) {
    return;
  }
  throw new HookDefinitionsClientError(
    response.status,
    safeErrorMessage(response.status),
  );
}

function safeErrorMessage(status: number): string {
  if (status === 401) {
    return "Sign in again to manage hooks.";
  }
  if (status === 403) {
    return "This hook is managed outside your personal settings.";
  }
  if (status === 404) {
    return "The selected workspace is no longer available.";
  }
  if (status === 409) {
    return "Hook configuration changed before it could be saved. Reload and try again.";
  }
  return "Hook settings could not be updated. Try again.";
}
