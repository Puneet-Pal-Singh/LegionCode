import type { TurnAdmission, TurnId } from "@repo/platform-protocol";
import type { LocalNativeFileIdentity } from "@repo/event-store";
import type { LocalTurnExecutor } from "./local-turns.js";
import type { LocalWorkspaceExecutionBinding } from "./local-workspace.js";
import { AppServerOperationError } from "./server.js";

export interface LocalTurnPreparation {
  readonly operation: Promise<unknown>;
  binding?: LocalWorkspaceExecutionBinding;
}

/** Constructed by this original binding owner only after successful close. */
export interface LocalTurnBindingClosure {
  readonly binding: LocalWorkspaceExecutionBinding;
  readonly root: LocalNativeFileIdentity;
  readonly gitMetadataIdentity: string;
  readonly grantedAt: string;
  readonly generation: number;
}

interface OwnedTurnExecution {
  readonly admission: TurnAdmission;
  readonly executor: LocalTurnExecutor;
  readonly binding: LocalWorkspaceExecutionBinding;
  readonly started: Promise<void>;
  readonly execution: Promise<unknown>;
  readonly cleanup: Promise<void>;
  stop?: Promise<void>;
}

/** One physical resource owner for preparation, execution and shutdown. Runtime
 * commands and positive runtime proof retain terminal and capture authority. */
export class LocalTurnResources {
  private readonly preparations = new Set<LocalTurnPreparation>();
  private readonly executors = new Map<TurnId, OwnedTurnExecution>();
  private readonly admissionController = new AbortController();
  private shutdownPromise?: Promise<void>;
  private stopping = false;

  constructor(
    private readonly options: {
      interrupt(admission: TurnAdmission): Promise<void>;
      hasUnsettledWorkspaceResources(): boolean;
      onResourcesReleased?(admission: TurnAdmission): Promise<void>;
    },
  ) {}

  get hasActiveExecutions(): boolean {
    return (
      this.preparations.size > 0 ||
      this.executors.size > 0 ||
      this.options.hasUnsettledWorkspaceResources()
    );
  }

  get admissionSignal(): AbortSignal {
    return this.admissionController.signal;
  }

  assertAcceptingAdmission(): void {
    if (this.stopping)
      throw new AppServerOperationError(
        503,
        "server_unavailable",
        "Local runtime is shutting down",
        "local_runtime_stopping",
        false,
      );
  }

  prepare<T>(
    operation: (preparation: LocalTurnPreparation) => Promise<T>,
  ): Promise<T> {
    this.assertAcceptingAdmission();
    const pending: Promise<T> = Promise.resolve().then(() => {
      this.assertAcceptingAdmission();
      return operation(preparation);
    });
    const preparation: LocalTurnPreparation = { operation: pending };
    this.preparations.add(preparation);
    const settled = () => {
      // Failed binding.close retains this exact context and descriptor. A clean
      // acquisition rejection belongs to the workspace owner's quarantine fact.
      if (!preparation.binding) this.preparations.delete(preparation);
    };
    void pending.then(settled, settled);
    return pending;
  }

  async closePreparation(preparation: LocalTurnPreparation): Promise<void> {
    const binding = preparation.binding;
    if (!binding) return;
    await binding.close();
    preparation.binding = undefined;
  }

  ownExecution(
    preparation: LocalTurnPreparation,
    admission: TurnAdmission,
    executor: LocalTurnExecutor,
  ): void {
    const binding = preparation.binding;
    if (!binding || this.executors.has(admission.turn.id)) throw retained();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const execution = Promise.resolve().then(() => {
      try {
        return executor.execute(admission);
      } finally {
        markStarted();
      }
    });
    const cleanup = execution
      .then(
        () => undefined,
        () => {
          console.error(
            "Local runtime execution rejected; canonical replay remains authoritative",
          );
        },
      )
      .then(async () => {
        // Neither fulfillment nor rejection is physical or terminal proof.
        if ((await executor.awaitResourceRelease(admission.turn.id)) !== true)
          throw retained();
        const recordSettlement = await executor.prepareResourceSettlement?.(admission);
        const root = recordSettlement ? await binding.rootDirectory.stat({ bigint: true }) : undefined;
        if (root && !root.isDirectory()) throw retained();
        await binding.close();
        if (recordSettlement && root) await recordSettlement(Object.freeze({
          binding,
          root: Object.freeze({ device: root.dev.toString(16), inode: root.ino.toString(16) }),
          gitMetadataIdentity: binding.metadataIdentity,
          grantedAt: binding.workspace.grantedAt,
          generation: binding.generation,
        }));
        if (this.executors.get(admission.turn.id) === owned)
          this.executors.delete(admission.turn.id);
        // This callback is part of the original tracked cleanup operation. The
        // shutdown fence is synchronous and prevents a late callback admitting.
        if (recordSettlement && root && !this.stopping) await this.options.onResourcesReleased?.(admission).catch(() => {
          console.error("Local queued input remains pending after resource cleanup");
        });
      });
    const owned: OwnedTurnExecution = {
      admission,
      executor,
      binding,
      started,
      execution,
      cleanup,
    };
    this.executors.set(admission.turn.id, owned);
    preparation.binding = undefined;
    void cleanup.catch(() => {
      console.error(
        "Local runtime resource release was not confirmed; binding retained",
      );
    });
    // An append dispatched before the shutdown fence can return its receipt
    // afterwards. It joins the same shutdown owner rather than escaping Stop.
    if (this.stopping) this.observeStop(owned);
  }

  getExecutor(turnId: TurnId): LocalTurnExecutor | undefined {
    return this.executors.get(turnId)?.executor;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopping = true;
    this.admissionController.abort("Local runtime is shutting down");
    this.shutdownPromise = Promise.resolve().then(() => this.finishShutdown());
    return this.shutdownPromise;
  }

  private observeStop(owned: OwnedTurnExecution): Promise<void> {
    owned.stop ??= owned.started.then(async () => {
      await this.options.interrupt(owned.admission);
      await owned.cleanup;
    });
    // A preparation may still be settling while this command fails. Keep the
    // rejection observed immediately; finishShutdown retains its exact result.
    void owned.stop.catch(() => undefined);
    return owned.stop;
  }

  private async finishShutdown(): Promise<void> {
    const owned = new Set(this.executors.values());
    for (const execution of owned) this.observeStop(execution);
    await Promise.allSettled(
      [...this.preparations].map((preparation) => preparation.operation),
    );
    for (const execution of this.executors.values()) {
      owned.add(execution);
      this.observeStop(execution);
    }
    if (this.preparations.size || this.options.hasUnsettledWorkspaceResources())
      throw retained();
    await Promise.all(
      [...owned].map((execution) => this.observeStop(execution)),
    );
    if (this.executors.size || this.options.hasUnsettledWorkspaceResources())
      throw retained();
  }
}

function retained(): Error {
  return new Error(
    "Local runtime shutdown requires confirmed terminal settlement and resource release",
  );
}
