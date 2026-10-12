export interface SessionReadState {
  sessionId: string;
  lastTerminalTurnId: string | null;
  lastAcknowledgedTerminalTurnId: string | null;
  acknowledgedAt: string | null;
}

export interface SessionReadReceipt {
  sessionId: string;
  viewerId: string;
  lastAcknowledgedTerminalTurnId: string;
  acknowledgedAt: string;
}

export interface AcknowledgeSessionReadReceiptInput {
  sessionId: string;
  viewerId: string;
  terminalTurnId: string;
  acknowledgedAt: string;
}

export interface SessionReadReceiptRepository {
  listReadStates(viewerId: string, sessionIds: readonly string[]): Promise<SessionReadState[]>;
  acknowledge(input: AcknowledgeSessionReadReceiptInput): Promise<SessionReadReceipt>;
}

export class SessionReadReceiptError extends Error {
  constructor(readonly code: "session_not_found" | "stale_terminal_turn", message: string) {
    super(message);
    this.name = "SessionReadReceiptError";
  }
}
