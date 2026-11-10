import type { SubmitUserInputResponseRequest, TurnId } from "@repo/platform-protocol";

type Responder = (input: SubmitUserInputResponseRequest) => Promise<void>;
export interface RunUserInputResponseRegistry {
  register(turnId: TurnId, respond: Responder): () => void;
  has(turnId: TurnId): boolean;
  respond(input: SubmitUserInputResponseRequest): Promise<boolean>;
}

/** Active owner routing only. Canonical kernel owns claims, events and effects. */
export class InMemoryRunUserInputResponseRegistry implements RunUserInputResponseRegistry {
  private readonly responders = new Map<TurnId, Responder>();
  private readonly inFlight = new Map<string, Promise<void>>();
  register(turnId: TurnId, respond: Responder): () => void {
    if (this.responders.has(turnId)) throw new Error("Question runtime owner is already registered");
    this.responders.set(turnId, respond);
    // Cleanup is bound to this actual owner callback, never a mutable picker.
    return () => { if (this.responders.get(turnId) === respond) this.responders.delete(turnId); };
  }
  has(turnId: TurnId): boolean { return this.responders.has(turnId); }
  async respond(input: SubmitUserInputResponseRequest): Promise<boolean> {
    const respond = this.responders.get(input.turnId);
    if (!respond) return false;
    const key = JSON.stringify(input);
    const existing = this.inFlight.get(key);
    if (existing) { await existing; return true; }
    const delivery = Promise.resolve().then(() => respond(input));
    this.inFlight.set(key, delivery);
    try { await delivery; } finally { if (this.inFlight.get(key) === delivery) this.inFlight.delete(key); }
    return true;
  }
}
