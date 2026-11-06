export type HarnessHostErrorCode =
  | "invalid_launch"
  | "unsupported_platform"
  | "process_not_quiescent"
  | "stale_session"
  | "duplicate_instance"
  | "session_busy"
  | "request_unavailable"
  | "journal_busy"
  | "journal_overflow"
  | "journal_corrupt";

/** Messages contain host failure categories only, never provider payloads or credentials. */
export class HarnessHostError extends Error {
  constructor(readonly code: HarnessHostErrorCode) {
    super(code);
    this.name = "HarnessHostError";
  }
}
