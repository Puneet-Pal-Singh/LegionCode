import type { CoreMessage } from "ai";
import type { TurnId } from "@repo/platform-protocol";

export interface ActiveThreadInput {
  readonly turnId: TurnId;
  readonly inputId: string;
  readonly clientInputId: string;
  readonly transcriptMessageId: string;
  readonly message: CoreMessage;
}

export type ActiveThreadInputAcceptor = (
  input: ActiveThreadInput,
) => Promise<number>;

export interface RunThreadInputRegistry {
  register(turnId: TurnId, accept: ActiveThreadInputAcceptor): void;
  has(turnId: TurnId): boolean;
  accept(input: ActiveThreadInput): Promise<number>;
  unregister(turnId: TurnId): void;
}

/** Routes exact-turn commands to the live owner without storing input state. */
export class InMemoryRunThreadInputRegistry implements RunThreadInputRegistry {
  private readonly acceptors = new Map<TurnId, ActiveThreadInputAcceptor>();

  register(turnId: TurnId, accept: ActiveThreadInputAcceptor): void {
    this.acceptors.set(turnId, accept);
  }

  has(turnId: TurnId): boolean {
    return this.acceptors.has(turnId);
  }

  async accept(input: ActiveThreadInput): Promise<number> {
    const accept = this.acceptors.get(input.turnId);
    if (!accept) throw new Error(`Turn ${input.turnId} has no live input owner`);
    return await accept(input);
  }

  unregister(turnId: TurnId): void {
    this.acceptors.delete(turnId);
  }
}
