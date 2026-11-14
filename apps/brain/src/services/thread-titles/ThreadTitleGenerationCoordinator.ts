import {
  ThreadTitleGenerationCoordinator as SharedThreadTitleGenerationCoordinator,
  type ThreadTitleGenerationDependencies,
} from "@legioncode/app-server/thread-titles";
import type { Env } from "../../types/ai";
import { ThreadTitleService } from "./ThreadTitleService";
import { createOpenRouterThreadTitleGenerator } from "./OpenRouterThreadTitleGenerator";
import { createSelectedThreadTitleGenerator } from "./SelectedThreadTitleGenerator";

export type {
  BackgroundTaskOwner,
  GenerateThreadTitleInput,
  ThreadTitleGenerator,
  ThreadTitlePersistence,
} from "@legioncode/app-server/thread-titles";

/** Hosted composition only: the shared server coordinator owns title policy. */
export class ThreadTitleGenerationCoordinator extends SharedThreadTitleGenerationCoordinator {
  constructor(env: Env, dependencies: Partial<ThreadTitleGenerationDependencies> = {}) {
    super({
      ...dependencies,
      generatorFactory: dependencies.generatorFactory ??
        ((input) => createSelectedThreadTitleGenerator(env, input)),
      fallbackGenerator: dependencies.fallbackGenerator ?? createOpenRouterThreadTitleGenerator(env),
      titleService: dependencies.titleService ?? new ThreadTitleService(env),
    });
  }
}
