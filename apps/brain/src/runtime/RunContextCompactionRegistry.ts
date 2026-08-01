import type { TurnId } from "@repo/platform-protocol";

export type ActiveTurnCompactor = (mode: "manual") => Promise<void>;

export interface RunContextCompactionRegistry {
  register(turnId: TurnId, compact: ActiveTurnCompactor): void;
  has(turnId: TurnId): boolean;
  request(turnId: TurnId): Promise<boolean>;
  unregister(turnId: TurnId): void;
}

/**
 * Control-plane routing only. Context state and compaction lifecycle remain
 * owned by RuntimeKernel; this registry never stores a projection or result.
 */
export class InMemoryRunContextCompactionRegistry
  implements RunContextCompactionRegistry
{
  private readonly compactors = new Map<TurnId, ActiveTurnCompactor>();

  register(turnId: TurnId, compact: ActiveTurnCompactor): void {
    this.compactors.set(turnId, compact);
  }

  has(turnId: TurnId): boolean {
    return this.compactors.has(turnId);
  }

  async request(turnId: TurnId): Promise<boolean> {
    const compact = this.compactors.get(turnId);
    if (!compact) return false;
    await compact("manual");
    return true;
  }

  unregister(turnId: TurnId): void {
    this.compactors.delete(turnId);
  }
}
