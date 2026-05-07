import { GitHubTaskStrategy } from "./GitHubTaskStrategy.js";
import { GitToolFailureClassifier } from "./GitToolFailureClassifier.js";
import { resolveGitTaskStrategyPolicy } from "./RunGitTaskStrategyPolicy.js";
import type {
  GitHubAuthAvailabilityChecker,
  RunEngineOptions,
} from "./RunEngineTypes.js";
import type { Run } from "../run/index.js";
import type { RunInput, RuntimeExecutionService } from "../types.js";

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

interface RuntimeExecutionResultLike {
  success: boolean;
  error?: string;
}

export async function restoreContinuationWorkspaceEditsIfNeeded(
  run: Run,
  executionService: RuntimeExecutionService | undefined,
): Promise<number> {
  if (!executionService) {
    return 0;
  }

  const continuation = run.metadata.continuation;
  const workspaceBootstrap = run.metadata.workspaceBootstrap;
  if (
    !workspaceBootstrap?.clonedDuringBootstrap ||
    !continuation ||
    continuation.restorableEdits.length === 0
  ) {
    return 0;
  }

  console.log(
    `[run/engine] Restoring ${continuation.restorableEdits.length} persisted edit(s) after workspace re-clone for run ${run.id}`,
  );
  const restoredPaths: string[] = [];
  for (const edit of continuation.restorableEdits) {
    assertSafeRestorableEditPath(edit.filePath);
    const result = await executionService.execute("filesystem", "write_file", {
      path: edit.filePath,
      content: edit.content,
    });
    if (!isRuntimeExecutionResultLike(result) || !result.success) {
      const restoreProgressMessage =
        restoredPaths.length > 0
          ? ` Restored before failure: ${restoredPaths.join(", ")}.`
          : "";
      throw new Error(
        `Failed to restore persisted workspace edit for ${edit.filePath}: ${
          isRuntimeExecutionResultLike(result)
            ? result.error ?? "unknown restore error"
            : "unexpected execution result"
        }.${restoreProgressMessage}`,
      );
    }
    restoredPaths.push(edit.filePath);
  }
  return continuation.restorableEdits.length;
}

function isRuntimeExecutionResultLike(
  value: unknown,
): value is RuntimeExecutionResultLike {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  return typeof (value as { success?: unknown }).success === "boolean";
}

function assertSafeRestorableEditPath(filePath: string): void {
  const trimmedPath = filePath.trim();
  if (!trimmedPath) {
    throw new Error("[run/engine] Cannot restore persisted edit with an empty path.");
  }

  if (trimmedPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmedPath)) {
    throw new Error(
      `[run/engine] Rejecting persisted edit path outside workspace scope: ${filePath}`,
    );
  }

  const pathSegments = trimmedPath.split(/[\\/]+/).filter(Boolean);
  if (pathSegments.includes("..")) {
    throw new Error(
      `[run/engine] Rejecting persisted edit path traversal attempt: ${filePath}`,
    );
  }
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
