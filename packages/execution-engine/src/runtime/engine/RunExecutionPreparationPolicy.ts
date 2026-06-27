import { GitHubTaskStrategy } from "./GitHubTaskStrategy.js";
import { GitToolFailureClassifier } from "./GitToolFailureClassifier.js";
import { resolveGitTaskStrategyPolicy } from "./RunGitTaskStrategyPolicy.js";
import type {
  GitHubAuthAvailabilityChecker,
  RunEngineOptions,
} from "./RunEngineTypes.js";
import type { Run } from "../run/index.js";
import type { RunInput } from "../types.js";

const gitHubTaskStrategy = new GitHubTaskStrategy();
const gitToolFailureClassifier = new GitToolFailureClassifier();

export async function resolveGitTaskStrategyForRun(input: {
  run: Run;
  runInput: RunInput;
  options: RunEngineOptions;
  hasGitHubAuthChecker?: GitHubAuthAvailabilityChecker;
}): Promise<Run["metadata"]["gitTaskStrategy"]> {
  const hasGitHubAuth = await resolveGitHubAuthAvailability(input);
  return resolveGitTaskStrategyPolicy({
    run: input.run,
    runInput: input.runInput,
    hasGitHubAuth,
    strategy: gitHubTaskStrategy,
    classifier: gitToolFailureClassifier,
  });
}

async function resolveGitHubAuthAvailability(input: {
  runInput: RunInput;
  options: RunEngineOptions;
  hasGitHubAuthChecker?: GitHubAuthAvailabilityChecker;
}): Promise<boolean> {
  if (!input.hasGitHubAuthChecker) {
    return false;
  }
  return Boolean(
    await input.hasGitHubAuthChecker({
      userId: input.options.userId,
      runId: input.options.runId,
      sessionId: input.options.sessionId,
      runInput: input.runInput,
    }),
  );
}
