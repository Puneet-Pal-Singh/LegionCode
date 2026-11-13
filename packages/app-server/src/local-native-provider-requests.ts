/** Original provider operations owned by one Native attempt. Cancellation can
 * settle the Kernel's observer before the underlying request actually returns. */
export class LocalNativeProviderRequests {
  private readonly originals = new Set<Promise<unknown>>();
  private fenced = false;

  track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.fenced) return Promise.reject(new Error("Native provider requests are closing"));
    // Register before invocation, including synchronous adapter failures.
    const original = Promise.resolve().then(() => {
      if (this.fenced) throw new Error("Native provider requests are closing");
      return operation();
    });
    this.originals.add(original);
    const settled = () => { this.originals.delete(original); };
    void original.then(settled, settled);
    return original;
  }

  /** Never replace original settlement with an abort receipt or a deadline. */
  async drain(): Promise<void> {
    this.fenced = true;
    await Promise.allSettled([...this.originals]);
  }
}
