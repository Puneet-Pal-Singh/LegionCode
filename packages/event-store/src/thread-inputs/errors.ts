export class ThreadInputConflictError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "ThreadInputConflictError";
  }
}
