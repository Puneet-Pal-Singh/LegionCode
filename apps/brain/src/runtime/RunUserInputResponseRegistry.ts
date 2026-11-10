import type { SubmitUserInputResponseRequest, TurnId } from "@repo/platform-protocol";

type Responder = (input: SubmitUserInputResponseRequest) => Promise<void>;
interface ActiveOwner {
  readonly respond: Responder;
  readonly inFlight: Map<string, Promise<void>>;
}
export interface RunUserInputResponseRegistry {
  register(turnId: TurnId, respond: Responder): () => void;
  has(turnId: TurnId): boolean;
  respond(input: SubmitUserInputResponseRequest): Promise<boolean>;
}

/** Active owner routing only. Canonical kernel owns claims, events and effects. */
export class InMemoryRunUserInputResponseRegistry implements RunUserInputResponseRegistry {
  private readonly owners = new Map<TurnId, ActiveOwner>();
  register(turnId: TurnId, respond: Responder): () => void {
    if (this.owners.has(turnId)) throw new Error("Question runtime owner is already registered");
    const owner: ActiveOwner = { respond, inFlight: new Map() };
    this.owners.set(turnId, owner);
    // Both cleanup and in-flight coalescing belong to this actual registration.
    return () => { if (this.owners.get(turnId) === owner) this.owners.delete(turnId); };
  }
  has(turnId: TurnId): boolean { return this.owners.has(turnId); }
  async respond(input: SubmitUserInputResponseRequest): Promise<boolean> {
    const owner = this.owners.get(input.turnId);
    if (!owner) return false;
    const key = JSON.stringify(input);
    const existing = owner.inFlight.get(key);
    if (existing) { await existing; return true; }
    const delivery = Promise.resolve().then(() => {
      if (this.owners.get(input.turnId) !== owner) throw new Error("Question runtime owner is no longer active");
      return owner.respond(input);
    });
    owner.inFlight.set(key, delivery);
    try { await delivery; } finally { if (owner.inFlight.get(key) === delivery) owner.inFlight.delete(key); }
    return true;
  }
}
