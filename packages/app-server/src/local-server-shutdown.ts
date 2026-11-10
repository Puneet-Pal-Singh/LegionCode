import type { Server } from "node:http";

type ShutdownResources = {
  readonly server: Server;
  readonly persistence: { close(): void };
  readonly runtime: { shutdown(): Promise<void> } | undefined;
  readonly hasUnsettledResources: () => boolean;
  keepAlive?: ReturnType<typeof setInterval>;
};

// Physical ownership only: failed cleanup must retain the actual objects and
// process liveness, not just leave a rejected promise without active handles.
const retainedShutdowns = new Set<ShutdownResources>();

/** HTTP closure is separate from canonical runtime/resource settlement. */
export function attachLocalServerShutdown(
  server: Server,
  persistence: { close(): void },
  runtime: { shutdown(): Promise<void> } | undefined,
  hasUnsettledResources: () => boolean,
): Server & { readonly closed: Promise<void>; requestShutdown(): Promise<void> } {
  let resolveClosed!: () => void;
  let rejectClosed!: (error: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  const resources: ShutdownResources = { server, persistence, runtime, hasUnsettledResources };
  retainedShutdowns.add(resources);
  let runtimeShutdown: Promise<void> | undefined;
  const beginRuntimeShutdown = () => {
    if (runtimeShutdown) return;
    resources.keepAlive = setInterval(() => undefined, 1_000);
    try { runtimeShutdown = runtime?.shutdown() ?? Promise.resolve(); }
    catch (error) { runtimeShutdown = Promise.reject(error); }
    void runtimeShutdown.catch(rejectClosed);
  };
  const closePersistence = () => {
    if (hasUnsettledResources()) throw new Error("Local workspace resources remain unsettled");
    persistence.close();
    if (resources.keepAlive) clearInterval(resources.keepAlive);
    retainedShutdowns.delete(resources);
    resolveClosed();
  };
  server.once("close", () => {
    beginRuntimeShutdown();
    if (!runtime) {
      try { closePersistence(); }
      catch (error) { rejectClosed(error); }
      return;
    }
    void runtimeShutdown!.then(closePersistence).catch(rejectClosed);
  });
  // Rejection retains persistence and its referenced keep-alive. Reporting fatal
  // must not convert an unknown physical outcome into successful shutdown.
  void closed.catch(() => server.emit("runtime-shutdown-failed"));
  return Object.assign(server, {
    closed,
    requestShutdown(): Promise<void> {
      // Fence admission and signal owned work before draining pending HTTP calls.
      beginRuntimeShutdown();
      server.close();
      return closed;
    },
  });
}
