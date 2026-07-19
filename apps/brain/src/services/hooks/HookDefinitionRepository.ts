import type {
  HookDefinition,
  HookHandlerId,
} from "@repo/hook-protocol";

export interface HookDefinitionScope {
  userId: string;
  workspaceId: string;
}

export interface HookDefinitionRecord {
  userId: string;
  workspaceId: string;
  definition: HookDefinition;
  createdAt: string;
  updatedAt: string;
}

/**
 * Brain owns hook configuration. Runtime owns invocation and lifecycle truth.
 */
export interface HookDefinitionRepository {
  list(
    scope: HookDefinitionScope,
  ): Promise<readonly HookDefinitionRecord[]>;
  upsert(
    scope: HookDefinitionScope,
    definition: HookDefinition,
    now: string,
  ): Promise<HookDefinitionRecord>;
  deleteUserDefinition(
    scope: HookDefinitionScope,
    handlerId: HookHandlerId,
  ): Promise<boolean>;
}

export class HookDefinitionWriteConflictError extends Error {
  readonly code = "HOOK_DEFINITION_WRITE_CONFLICT";

  constructor() {
    super("Hook definition scope or provenance changed before persistence");
    this.name = "HookDefinitionWriteConflictError";
  }
}
