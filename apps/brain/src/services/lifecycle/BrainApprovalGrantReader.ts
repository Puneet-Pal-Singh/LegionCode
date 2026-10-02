import {
  PostgresLifecycleApprovalGrantReader,
  type MatchingInChatApprovalGrantQuery,
} from "@repo/persistence";
import type { ApprovalGrantReader } from "@legioncode/execution-engine/runtime";
import type { Env } from "../../types/ai";
import { withBrainPersistenceRepository } from "../persistence/BrainPersistenceRepositoryFactory";

/** Reads reusable approvals from the canonical lifecycle event stream. */
export class BrainApprovalGrantReader implements ApprovalGrantReader {
  constructor(private readonly env: Env) {}

  async hasMatchingInChatGrant(
    input: MatchingInChatApprovalGrantQuery,
  ): Promise<boolean> {
    return await withBrainPersistenceRepository(
      this.env,
      undefined,
      (client) => new PostgresLifecycleApprovalGrantReader(client),
      (reader) => reader.hasMatchingInChatGrant(input),
    );
  }
}
