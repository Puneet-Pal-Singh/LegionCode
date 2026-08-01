import type { TurnId } from "@repo/platform-protocol";

export type ActiveTurnInterrupt = (reason: string) => Promise<void>;

export interface RunInterruptRegistry {
  register(turnId: TurnId, interrupt: ActiveTurnInterrupt): string | null;
  request(turnId: TurnId, reason: string): Promise<boolean>;
  unregister(turnId: TurnId): void;
}

interface RegisteredInterrupt {
  readonly interrupt: ActiveTurnInterrupt;
  request: Promise<void> | null;
}

export class InMemoryRunInterruptRegistry implements RunInterruptRegistry {
  private readonly interrupts = new Map<TurnId, RegisteredInterrupt>();
  private readonly pending = new Map<TurnId, string>();

  register(turnId: TurnId, interrupt: ActiveTurnInterrupt): string | null {
    this.interrupts.set(turnId, { interrupt, request: null });
    const reason = this.pending.get(turnId) ?? null;
    if (reason) this.pending.delete(turnId);
    return reason;
  }

  async request(turnId: TurnId, reason: string): Promise<boolean> {
    const registered = this.interrupts.get(turnId);
    if (!registered) {
      this.pending.set(turnId, reason);
      return true;
    }

    registered.request ??= registered.interrupt(reason);
    await registered.request;
    return true;
  }

  unregister(turnId: TurnId): void {
    this.interrupts.delete(turnId);
    this.pending.delete(turnId);
  }
}
