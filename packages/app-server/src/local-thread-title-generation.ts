import type { LocalPersistence } from "@repo/event-store/local";
import type { ThreadId, TurnAdmission } from "@repo/platform-protocol";
import type { BYOKDiscoveredProviderModel } from "@repo/shared-types";
import type { LocalThreadService } from "./local-threads.js";
import type { LocalWorkspaceService } from "./local-workspace.js";
import type { LocalGeneratedTitleClaim, LocalGeneratedTitleScope } from "./local-thread-generated-titles.js";
import {
  ThreadTitleGenerationCoordinator,
  type BackgroundTaskOwner,
  type ThreadTitleGenerator,
} from "./thread-titles/index.js";

/** Owned only by LocalTurnService. Logical title deadlines never release original requests. */
export class LocalThreadTitleGeneration implements BackgroundTaskOwner {
  private readonly jobs = new Set<Promise<unknown>>();
  private readonly originals = new Set<Promise<unknown>>();
  private readonly controller = new AbortController();
  private recovery?: Promise<void>;
  private stopping = false;

  constructor(private readonly options: {
    threads: LocalThreadService;
    admissions: LocalPersistence["turnAdmissions"];
    getWorkspace: LocalWorkspaceService["getAuthorizedCurrent"];
    createGenerator?: (admission: TurnAdmission, model: BYOKDiscoveredProviderModel) => ThreadTitleGenerator;
  }) {}

  get hasActiveWork(): boolean { return this.jobs.size > 0 || this.originals.size > 0; }

  /** Invoked only after actual shutdown owners are attached, before command readiness. */
  initialize(): Promise<void> {
    if (this.recovery) return this.recovery;
    if (this.stopping) return Promise.reject(new Error("Local title owner is shutting down"));
    this.recovery = this.track(this.jobs, Promise.resolve().then(() => {
      if (this.stopping) throw new Error("Local title owner is shutting down");
      return this.options.threads.recoverGeneratedTitleMetadata((id) => this.readFirst(id));
    }));
    return this.recovery;
  }

  async prepareFirstAdmission(admission: TurnAdmission, model: BYOKDiscoveredProviderModel): Promise<void> {
    const createGenerator = this.options.createGenerator;
    if (!createGenerator || this.stopping) return;
    await this.initialize();
    if (this.stopping) return;
    const readFirst = () => this.readFirst(admission.turn.threadId);
    // Durable claim is awaited before the confirmed admission is returned.
    const claim = await this.options.threads.generatedTitles.claim(admission, readFirst);
    if (!claim) return;
    const coordinator = new ThreadTitleGenerationCoordinator<LocalGeneratedTitleScope>({
      generatorFactory: () => this.wrapGenerator(createGenerator(admission, model), claim),
      titleService: {
        persist: (result) => {
          if (result.source !== "generated" || result.expectedTitleVersion !== claim.previewVersion)
            throw new Error("Local title publication does not match its pending claim");
          return this.options.threads.generatedTitles.settle(claim, { status: "ready", title: result.title }, readFirst);
        },
        persistFailure: (result) => {
          if (result.expectedTitleVersion !== claim.previewVersion)
            throw new Error("Local title settlement does not match its pending claim");
          return this.options.threads.generatedTitles.settle(claim, { status: "failed" }, readFirst);
        },
      },
    });
    coordinator.schedule(this, {
      ...claim.scope, prompt: claim.prompt, previewVersion: claim.previewVersion,
      providerId: claim.providerId, modelId: claim.modelId,
      runtimeModelId: model.runtimeRoute?.modelId,
      providerTransport: model.runtimeRoute?.transport,
      providerEndpoint: model.runtimeRoute?.endpoint,
      modelCapabilities: model.capabilities,
    });
  }

  waitUntil(promise: Promise<unknown>): void { this.track(this.jobs, promise); }

  stop(): void {
    this.stopping = true;
    this.controller.abort("Local title owner is shutting down");
  }

  /** Caller first joins admission preparations, so no later claim can schedule work. */
  async drain(): Promise<void> {
    while (this.jobs.size || this.originals.size)
      await Promise.allSettled([...this.jobs, ...this.originals]);
  }

  private wrapGenerator(generator: ThreadTitleGenerator, claim: LocalGeneratedTitleClaim): ThreadTitleGenerator {
    return {
      outputFormat: generator.outputFormat,
      generateText: (request) => {
        const signal = AbortSignal.any([this.controller.signal, ...(request.signal ? [request.signal] : [])]);
        const operation = Promise.resolve().then(async () => {
          signal.throwIfAborted();
          const grant = await this.options.getWorkspace();
          signal.throwIfAborted();
          if (!grant || grant.readiness !== "ready" || grant.workspaceId !== claim.scope.workspaceId ||
              grant.grantedAt !== claim.scope.grantedAt || grant.repositoryIdentity !== claim.scope.repositoryIdentity)
            throw new Error("Local title workspace grant changed");
          // Keep the ORIGINAL protected inference Promise, not only the coordinator's race.
          const original = generator.generateText({ ...request, signal });
          this.track(this.originals, original);
          return await original;
        });
        // Authorization may itself be pending; it also remains owned through shutdown.
        return this.track(this.originals, operation);
      },
    };
  }

  private track<T>(set: Set<Promise<unknown>>, promise: Promise<T>): Promise<T> {
    set.add(promise);
    void promise.then(() => set.delete(promise), () => set.delete(promise));
    return promise;
  }

  private async readFirst(threadId: ThreadId): Promise<TurnAdmission | null> {
    const page = await this.options.admissions.listByThread({ threadId, afterCursor: null, limit: 1 });
    return page.admissions[0] ?? null;
  }
}
