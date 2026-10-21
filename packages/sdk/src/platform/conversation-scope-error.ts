export class ConversationScopeHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(input: {
    status: number;
    code: string;
    message: string;
    retryable?: boolean;
  }) {
    super(input.message);
    this.name = "ConversationScopeHttpError";
    this.status = input.status;
    this.code = input.code;
    this.retryable =
      input.retryable ??
      (input.status >= 500 || input.status === 408 || input.status === 429);
  }
}
