import type { CoreMessage } from "ai";
import type { Env } from "../../types/ai";
import { AIService } from "../AIService";
import {
  ThreadTitleService,
  type PersistThreadTitleInput,
} from "./ThreadTitleService";
import { createPostgresProviderConfigService } from "../providers/stores/PostgresStoreFactory";

export interface BackgroundTaskOwner {
  waitUntil(promise: Promise<unknown>): void;
}

export interface GenerateThreadTitleInput extends Omit<
  PersistThreadTitleInput,
  "title" | "source"
> {
  prompt: string;
  previewVersion: number;
  providerId?: string;
  modelId?: string;
}

export interface ThreadTitleGenerator {
  generateText(input: {
    messages: CoreMessage[];
    model?: string;
    providerId?: string;
    temperature?: number;
    signal?: AbortSignal;
  }): Promise<{ text: string }>;
}

export interface ThreadTitlePersistence {
  persist(input: PersistThreadTitleInput): Promise<unknown>;
}

interface ThreadTitleGenerationDependencies {
  generator?: ThreadTitleGenerator;
  generatorFactory?: (input: GenerateThreadTitleInput) => ThreadTitleGenerator;
  titleService?: ThreadTitlePersistence;
}

const TITLE_GENERATION_TIMEOUT_MS = 20_000;

/**
 * Schedules title inference only through a Worker-owned waitUntil lifecycle.
 * Missing credentials, provider failure, timeout, or invalid output leave the
 * deterministic preview untouched.
 */
export class ThreadTitleGenerationCoordinator {
  private readonly generator?: ThreadTitleGenerator;
  private readonly generatorFactory: (
    input: GenerateThreadTitleInput,
  ) => ThreadTitleGenerator;
  private readonly titleService: ThreadTitlePersistence;

  constructor(env: Env, dependencies: ThreadTitleGenerationDependencies = {}) {
    this.generator = dependencies.generator;
    this.generatorFactory =
      dependencies.generatorFactory ??
      ((input) =>
        new AIService(
          env,
          createPostgresProviderConfigService(
            env,
            input.userId,
            input.workspaceId,
          ),
        ));
    this.titleService =
      dependencies.titleService ?? new ThreadTitleService(env);
  }

  schedule(owner: BackgroundTaskOwner, input: GenerateThreadTitleInput): void {
    owner.waitUntil(this.generate(input));
  }

  private async generate(input: GenerateThreadTitleInput): Promise<void> {
    const abortController = new AbortController();
    const timeout = setTimeout(
      () => abortController.abort(),
      TITLE_GENERATION_TIMEOUT_MS,
    );
    try {
      const messages: CoreMessage[] = [
        {
          role: "system",
          content:
            "Create a concise, neutral 3 to 6 word task title. Return only the title as plain text. Do not include quotes, punctuation, secrets, file contents, tool output, or reasoning.",
        },
        { role: "user", content: input.prompt },
      ];
      const generator = this.generator ?? this.generatorFactory(input);
      const result = await generator.generateText({
        messages,
        providerId: input.providerId,
        model: input.modelId,
        temperature: 0,
        signal: abortController.signal,
      });
      const title = normalizeGeneratedTitle(result.text);
      if (!title) {
        console.warn("[thread-title] generation_failed reason=invalid_output");
        return;
      }
      await this.titleService.persist({
        ...input,
        title,
        source: "generated",
        expectedTitleVersion: input.previewVersion,
      });
    } catch (error) {
      console.warn(
        `[thread-title] generation_failed reason=${classifyTitleGenerationFailure(
          error,
          abortController.signal.aborted,
        )}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function classifyTitleGenerationFailure(
  error: unknown,
  didTimeOut: boolean,
): "timeout" | "invalid_output" | "provider_unavailable" {
  if (didTimeOut) {
    return "timeout";
  }
  if (
    error instanceof Error &&
    /schema|parse|validation/i.test(error.message)
  ) {
    return "invalid_output";
  }
  return "provider_unavailable";
}

function normalizeGeneratedTitle(value: string): string | null {
  const firstLine = value.split(/\r?\n/, 1)[0] ?? "";
  const title = firstLine
    .replace(/^[\s"'`]+|[\s"'`.,:;!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!title) {
    return null;
  }
  const wordCount = title.split(" ").filter(Boolean).length;
  if (wordCount < 3 || wordCount > 6 || title.length > 80) {
    return null;
  }
  return title;
}
