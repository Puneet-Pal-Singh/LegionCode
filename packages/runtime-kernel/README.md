# Runtime Kernel

`@repo/runtime-kernel` owns turn execution coordination without depending on
application controllers, UI components, or infrastructure-specific workers.

The kernel:

1. loads the durable `WorkspaceManifest` for the run,
2. assembles context through a narrow port,
3. drives provider and worker tool calls,
4. waits for typed approval decisions,
5. records canonical protocol events through `EventStore`.

Adapters for provider, worker, approval, and context responsibilities live
outside this package. Workspace truth remains owned by `workspace-core`, and
canonical history remains owned by `event-store`.
