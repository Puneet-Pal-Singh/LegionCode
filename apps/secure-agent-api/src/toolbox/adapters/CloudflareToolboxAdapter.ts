import type { Sandbox } from "@cloudflare/sandbox";
import type {
  ToolboxCommandExecutionOptions,
  ToolboxCommandExecutor,
  ToolboxCommandResult,
} from "../contracts/ToolboxSession";

export class CloudflareToolboxAdapter implements ToolboxCommandExecutor {
  constructor(private sandbox: Sandbox) {}

  async execute(
    command: string,
    options?: ToolboxCommandExecutionOptions,
  ): Promise<ToolboxCommandResult> {
    return await executeWithSandboxSessionRetry(this.sandbox, command, options);
  }
}

const SANDBOX_SESSION_RETRY_DELAYS_MS = [250, 750] as const;

async function executeWithSandboxSessionRetry(
  sandbox: Sandbox,
  command: string,
  options?: ToolboxCommandExecutionOptions,
): Promise<ToolboxCommandResult> {
  let attempt = 0;

  while (true) {
    try {
      return (await sandbox.exec(command, {
        cwd: options?.cwd,
        env: options?.env,
      })) as ToolboxCommandResult;
    } catch (error) {
      const retryDelayMs = SANDBOX_SESSION_RETRY_DELAYS_MS[attempt];
      if (
        retryDelayMs === undefined ||
        !isRetriableSandboxSessionError(error)
      ) {
        throw error;
      }

      await delay(retryDelayMs);
      attempt += 1;
    }
  }
}

function isRetriableSandboxSessionError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("http error! status: 500") ||
    message.includes("createsession")
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
