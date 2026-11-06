import { HarnessHostError } from "./errors.js";

/** Private provider request ids are scoped to their exact live session origin. */
export class ScopedRequestReply<T> {
  private state: "pending" | "consumed" | "fenced" = "pending";

  constructor(
    readonly requestId: string,
    readonly origin: string,
    readonly processGeneration: string,
    readonly authOwnerGeneration: number,
    private readonly send: (value: T) => Promise<void>,
    private readonly isActive: () => boolean,
  ) {
    if (
      !requestId ||
      !origin ||
      !processGeneration ||
      !Number.isSafeInteger(authOwnerGeneration) ||
      authOwnerGeneration < 0
    ) {
      throw new HarnessHostError("request_unavailable");
    }
  }

  async reply(input: {
    readonly requestId: string;
    readonly origin: string;
    readonly processGeneration: string;
    readonly authOwnerGeneration: number;
    readonly value: T;
  }): Promise<void> {
    if (
      this.state !== "pending" ||
      !this.isActive() ||
      input.requestId !== this.requestId ||
      input.origin !== this.origin ||
      input.processGeneration !== this.processGeneration ||
      input.authOwnerGeneration !== this.authOwnerGeneration
    ) {
      throw new HarnessHostError("request_unavailable");
    }
    // Consume before I/O: a failed write has an ambiguous outcome and must never retry.
    this.state = "consumed";
    await this.send(input.value);
  }

  fence(): void {
    this.state = "fenced";
  }
}
