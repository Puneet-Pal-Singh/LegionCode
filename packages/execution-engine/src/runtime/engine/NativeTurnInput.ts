import type {
  AcceptedThreadInput,
  AppliedThreadInput,
} from "@repo/runtime-kernel";

/** Keeps accepted steering until it is included in a provider request. */
export class NativeTurnInputBuffer {
  private readonly pending: AcceptedThreadInput[] = [];
  private readonly staged: AcceptedThreadInput[] = [];
  private contextRevision = 0;

  enqueue(input: AcceptedThreadInput): void {
    this.pending.push(input);
  }

  hasPending(): boolean {
    return this.pending.length > 0;
  }

  flush(append: (messages: readonly AcceptedThreadInput["message"][]) => void): boolean {
    if (this.pending.length === 0) return false;
    const batch = this.pending.splice(0, this.pending.length);
    append(batch.map((accepted) => accepted.message));
    this.staged.push(...batch);
    return true;
  }

  async acknowledge(
    modelStep: number,
    onApplied?: (inputs: readonly AppliedThreadInput[]) => Promise<void>,
  ): Promise<void> {
    if (this.staged.length === 0) return;
    const applied = this.staged.map((accepted) => ({
      inputId: accepted.inputId,
      acceptedSequence: accepted.acceptedSequence,
      modelStep,
      contextRevision: ++this.contextRevision,
    }));
    await onApplied?.(applied);
    this.staged.splice(0, applied.length);
  }
}
