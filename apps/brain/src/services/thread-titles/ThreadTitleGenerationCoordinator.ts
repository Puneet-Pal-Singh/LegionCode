import type { CoreMessage } from "ai";
import { GeneratedThreadTitleSchema } from "@repo/platform-protocol";
import type { Env } from "../../types/ai";
import { AIService } from "../AIService";
import { ThreadTitleService, type PersistThreadTitleInput } from "./ThreadTitleService";

export interface BackgroundTaskOwner {
  waitUntil(promise: Promise<unknown>): void;
}

export interface GenerateThreadTitleInput
  extends Omit<PersistThreadTitleInput, "title" | "source"> {
  prompt: string;
  previewVersion: number;
  providerId?: string;
  modelId?: string;
}

export interface ThreadTitleGenerator {
  generateStructured<T>(input: {
    messages: CoreMessage[];
    schema: { parse(value: unknown): T };
    model?: string;
    providerId?: string;
    temperature?: number;
    maxTokens?: number;
    abortSignal?: AbortSignal;
  }): Promise<{ object: T }>;
}

export interface ThreadTitlePersistence {
  persist(input: PersistThreadTitleInput): Promise<unknown>;
}

interface ThreadTitleGenerationDependencies {
  generator?: ThreadTitleGenerator;
  titleService?: ThreadTitlePersistence;
}

const TITLE_GENERATION_TIMEOUT_MS = 7_500;

/**
 * Schedules title inference only through a Worker-owned waitUntil lifecycle.
 * Missing credentials, unsupported structured output, timeout, or invalid
 * output leave the deterministic preview untouched.
 */
export class ThreadTitleGenerationCoordinator {
  private readonly generator: ThreadTitleGenerator;
  private readonly titleService: ThreadTitlePersistence;

  constructor(env: Env, dependencies: ThreadTitleGenerationDependencies = {}) {
    this.generator = dependencies.generator ?? new AIService(env);
    this.titleService = dependencies.titleService ?? new ThreadTitleService(env);
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
            "Create a concise, neutral 3 to 6 word task title. Return only the requested structured object. Do not include secrets, file contents, tool output, or reasoning.",
        },
        { role: "user", content: input.prompt },
      ];
      const result = await this.generator.generateStructured({
        messages,
        schema: GeneratedThreadTitleSchema,
        providerId: input.providerId,
        model: input.modelId,
        temperature: 0,
        maxTokens: 32,
        abortSignal: abortController.signal,
      });
      const title = normalizeGeneratedTitle(result.object.title);
      if (!title) {
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
  if (error instanceof Error && /schema|parse|validation/i.test(error.message)) {
    return "invalid_output";
  }
  return "provider_unavailable";
}

function normalizeGeneratedTitle(value: string): string | null {
  const title = value.replace(/\s+/g, " ").trim();
  const wordCount = title.split(" ").filter(Boolean).length;
  if (wordCount < 3 || wordCount > 6 || title.length > 80) {
    return null;
  }
  return title;
}
