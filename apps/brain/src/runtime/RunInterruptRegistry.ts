import type { TurnId } from "@repo/platform-protocol";

export type ActiveTurnInterrupt = (reason: string) => Promise<void>;

export interface RunInterruptRegistry {
  register(turnId: TurnId, interrupt: ActiveTurnInterrupt): void;
  request(turnId: TurnId, reason: string): Promise<boolean>;
  unregister(turnId: TurnId): void;
}

interface RegisteredInterrupt {
  readonly interrupt: ActiveTurnInterrupt;
  request: Promise<void> | null;
}

export class InMemoryRunInterruptRegistry implements RunInterruptRegistry {
  private readonly interrupts = new Map<TurnId, RegisteredInterrupt>();

  register(turnId: TurnId, interrupt: ActiveTurnInterrupt): void {
    this.interrupts.set(turnId, { interrupt, request: null });
  }

  async request(turnId: TurnId, reason: string): Promise<boolean> {
    const registered = this.interrupts.get(turnId);
    if (!registered) {
      return false;
    }

    registered.request ??= registered.interrupt(reason);
    await registered.request;
    return true;
  }

  unregister(turnId: TurnId): void {
    this.interrupts.delete(turnId);
  }
}
