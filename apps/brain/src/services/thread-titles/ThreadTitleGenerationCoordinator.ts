import {
  ThreadTitleGenerationCoordinator as SharedThreadTitleGenerationCoordinator,
  type GenerateThreadTitleInput as SharedGenerateThreadTitleInput,
  type HostedThreadTitleScope,
  type ThreadTitleGenerationDependencies,
} from "@legioncode/app-server/thread-titles";
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
interface NativeHostedTitleScope extends HostedThreadTitleScope {
  readonly nativeProviderCredentials?: NativeProviderCredentialContext;
}
export type GenerateThreadTitleInput = SharedGenerateThreadTitleInput<NativeHostedTitleScope>;

/** Hosted composition only: the shared server coordinator owns title policy. */
export class ThreadTitleGenerationCoordinator extends SharedThreadTitleGenerationCoordinator<NativeHostedTitleScope> {
  constructor(env: Env, dependencies: Partial<ThreadTitleGenerationDependencies<NativeHostedTitleScope>> = {}) {
    super({
      ...dependencies,
      generatorFactory: dependencies.generatorFactory ??
        ((input) => createSelectedThreadTitleGenerator(env, input)),
      fallbackGenerator: dependencies.fallbackGenerator ?? createOpenRouterThreadTitleGenerator(env),
      titleService: dependencies.titleService ?? new ThreadTitleService(env),
    });
  }
}
