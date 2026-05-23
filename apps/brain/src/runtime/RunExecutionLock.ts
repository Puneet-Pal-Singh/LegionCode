export class RunExecutionLock {
  private readonly queues = new Map<string, Promise<void>>();

  async run<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(runId) ?? Promise.resolve();
    let releaseCurrent: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.queues.set(runId, tail);

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      releaseCurrent();
      if (this.queues.get(runId) === tail) {
        this.queues.delete(runId);
      }
    }
  }

  pendingRunCount(): number {
    return this.queues.size;
  }
}
