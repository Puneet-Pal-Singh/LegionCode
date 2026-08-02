import type {
  ApprovalId,
  ApprovalDecision,
  TurnId,
  UserId,
} from "@repo/platform-protocol";

export interface ActiveTurnApprovalResolution {
  readonly decision: ApprovalDecision;
  readonly decidedBy: UserId | null;
  readonly reason: string | null;
}

export type ActiveTurnApprovalResolver = (
  approvalId: ApprovalId,
  resolution: ActiveTurnApprovalResolution,
) => Promise<void>;

export interface RunApprovalResolutionRegistry {
  register(turnId: TurnId, resolve: ActiveTurnApprovalResolver): void;
  has(turnId: TurnId): boolean;
  resolve(
    turnId: TurnId,
    approvalId: ApprovalId,
    resolution: ActiveTurnApprovalResolution,
  ): Promise<boolean>;
  unregister(turnId: TurnId): void;
}

/**
 * Routes a user decision to the runtime that owns the active turn. The registry
 * intentionally contains no lifecycle state: RuntimeKernel remains the only
 * producer of approval.decided.
 */
export class InMemoryRunApprovalResolutionRegistry
  implements RunApprovalResolutionRegistry
{
  private readonly resolvers = new Map<TurnId, ActiveTurnApprovalResolver>();

  register(turnId: TurnId, resolve: ActiveTurnApprovalResolver): void {
    this.resolvers.set(turnId, resolve);
  }

  has(turnId: TurnId): boolean {
    return this.resolvers.has(turnId);
  }

  async resolve(
    turnId: TurnId,
    approvalId: ApprovalId,
    resolution: ActiveTurnApprovalResolution,
  ): Promise<boolean> {
    const resolver = this.resolvers.get(turnId);
    if (!resolver) {
      return false;
    }
    await resolver(approvalId, resolution);
    return true;
  }

  unregister(turnId: TurnId): void {
    this.resolvers.delete(turnId);
  }
}
