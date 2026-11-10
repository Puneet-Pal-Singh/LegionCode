import type { Server } from "node:http";

export type LocalShutdownOwner = { shutdown(): Promise<void> };

/** Fence every actual owner synchronously, then await all original cleanup.
 * Rejection is never transformed into a positive physical closure receipt. */
export function combineLocalShutdownOwners(
  ...services: Array<LocalShutdownOwner | undefined>
): LocalShutdownOwner | undefined {
  const owners = services.filter((service): service is LocalShutdownOwner => service !== undefined);
  if (!owners.length) return undefined;
  let shutdown: Promise<void> | undefined;
  return {
    shutdown(): Promise<void> {
      if (shutdown) return shutdown;
      const pending = owners.map((owner) => {
        try { return owner.shutdown(); }
        catch (error) { return Promise.reject(error); }
      });
      shutdown = Promise.allSettled(pending).then((results) => {
        if (results.some((result) => result.status === "rejected"))
          throw new Error("Owned local resources remain unsettled");
      });
      return shutdown;
    },
  };
}

type ShutdownResources = {
  readonly server: Server;
  readonly persistence: { close(): void };
  readonly runtime: LocalShutdownOwner | undefined;
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
  runtime: LocalShutdownOwner | undefined,
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
