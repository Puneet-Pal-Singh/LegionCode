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
    if (options?.borrowedLease) {
      return await this.sandbox.execIfRunning(command, {
        cwd: options.cwd,
        env: options.env,
      });
    }
    // An SDK/session error does not prove that the command never ran. Setup
    // recovery belongs before dispatch; this execution is attempted only once.
    return await this.sandbox.exec(command, {
      cwd: options?.cwd,
      env: options?.env,
    });
  }
}
