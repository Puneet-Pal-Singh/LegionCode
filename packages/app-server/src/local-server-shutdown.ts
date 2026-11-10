import type { Server } from "node:http";

/** HTTP closure is separate from canonical runtime/resource settlement. */
export function attachLocalServerShutdown(
  server: Server,
  persistence: { close(): void },
  runtime?: { shutdown(): Promise<void> },
): Server & { readonly closed: Promise<void> } {
  let resolveClosed!: () => void;
  let rejectClosed!: (error: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  let started = false;
  server.once("close", () => {
    if (started) return;
    started = true;
    if (!runtime) {
      try { persistence.close(); resolveClosed(); }
      catch (error) { rejectClosed(error); }
      return;
    }
    void Promise.resolve().then(() => runtime.shutdown()).then(() => {
      persistence.close();
      resolveClosed();
    }).catch(rejectClosed);
  });
  // Rejection retains the persistence owner. The utility process reports fatal
  // but must not turn an unknown physical outcome into successful shutdown.
  void closed.catch(() => server.emit("runtime-shutdown-failed"));
  return Object.assign(server, { closed });
}
