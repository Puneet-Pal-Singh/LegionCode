import {
  ThreadTitleGenerationCoordinator as SharedThreadTitleGenerationCoordinator,
  type GenerateThreadTitleInput as SharedGenerateThreadTitleInput,
  type HostedThreadTitleScope,
  type ThreadTitleGenerationDependencies,
} from "@legioncode/app-server/thread-titles";
import type { LLMRuntimeAIService } from "@legioncode/execution-engine/runtime";
import type { NativeProviderBindingScope } from "@repo/persistence";
import type { Env } from "../../types/ai";
import type { NativeProviderCredentialContext } from "../providers/NativeProviderCredentialResolver";
import { ThreadTitleService } from "./ThreadTitleService";
import { createOpenRouterThreadTitleGenerator } from "./OpenRouterThreadTitleGenerator";
import { createSelectedThreadTitleGenerator } from "./SelectedThreadTitleGenerator";

export type {
  BackgroundTaskOwner,
  ThreadTitleGenerator,
  ThreadTitlePersistence,
} from "@legioncode/app-server/thread-titles";

/** Private hosted authority travels only through the server's injected title factory. */
export interface NativeTitleExecution {
  readonly service: Pick<LLMRuntimeAIService, "generateText" | "generateStructured">;
  readonly scope: NativeProviderBindingScope;
  readonly signal: AbortSignal;
}
interface NativeHostedTitleScope extends HostedThreadTitleScope {
  readonly nativeExecution?: NativeTitleExecution;
  readonly nativeProviderCredentials?: NativeProviderCredentialContext;
}
export type GenerateThreadTitleInput = SharedGenerateThreadTitleInput<NativeHostedTitleScope>;

/** Hosted composition only: the shared server coordinator owns title policy. */
export class ThreadTitleGenerationCoordinator extends SharedThreadTitleGenerationCoordinator<NativeHostedTitleScope> {
  constructor(env: Env, dependencies: Partial<ThreadTitleGenerationDependencies<NativeHostedTitleScope>> = {}, claimedExecution?: NativeTitleExecution) {
    super({
      ...dependencies,
      // A claimed Native request may use neither an injected legacy generator
      // nor a platform/provider fallback outside that admitted service.
      generator: claimedExecution ? undefined : dependencies.generator,
      generatorFactory: claimedExecution
        ? (input => createSelectedThreadTitleGenerator(env, { ...input, nativeExecution: claimedExecution }))
        : dependencies.generatorFactory ?? (input => createSelectedThreadTitleGenerator(env, input)),
      fallbackGenerator: claimedExecution ? undefined : dependencies.fallbackGenerator ?? createOpenRouterThreadTitleGenerator(env),
      titleService: dependencies.titleService ?? new ThreadTitleService(env),
    });
  }
}
