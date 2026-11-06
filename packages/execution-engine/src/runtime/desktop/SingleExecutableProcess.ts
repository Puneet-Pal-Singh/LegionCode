import type { SingleProcessMacSandbox } from "./SingleProcessMacSandbox.js";
export { SingleProcessMacCapabilityError, type SingleProcessMacSandbox } from "./SingleProcessMacSandbox.js";
import type { LocalProcessOutput } from "./BoundedLocalProcess.js";
import { GuardianProcess } from "./GuardianProcess.js";
export { SingleProcessMacLifetimeUncertainError } from "./GuardianProcess.js";

export type SingleExecutableProcessInput = {
  /** Absolute executable path. No shell parsing, translation or expansion. */
  executable: string;
  args: readonly string[];
  cwd: string;
  signal: AbortSignal;
  sandbox: SingleProcessMacSandbox;
  /** Trusted packaged guardian path supplied only by the private runtime composition. */
  processHelperPath: string;
  /** Optional private writer-fence open description; never model or renderer input. */
  writerLeaseFd?: number;
  /** The same held workspace directory descriptor supplied by the grant owner. */
  workspaceRootFd: number;
  /** Canonical Git owner only; not accepted by run_executable/model/renderer input. */
  trustedGit?: {
    environment: Readonly<Record<string, string>>;
    stdin?: string;
    timeoutMs: number;
  };
};

export interface SingleProcessMacExecution {
  readonly scope: "single_executable_nofork";
  readonly result: Promise<LocalProcessOutput>;
  readonly quiescent: boolean;
  stop(): void;
}

/** Shared OS execution port for canonical command and local Git consumers. */
export type SingleProcessMacExecutor = (
  input: SingleExecutableProcessInput,
) => SingleProcessMacExecution;

export const executeSingleProcessMac: SingleProcessMacExecutor = (input) =>
  new SingleExecutableProcess(input);

/**
 * Darwin-only no-fork process primitive with explicit invoking-user host authority.
 * The trusted runtime must validate the canonical tool call, exact attempt,
 * grant, permission and approval, and acquire real capture before calling it.
 */
export class SingleExecutableProcess implements SingleProcessMacExecution {
  readonly scope = "single_executable_nofork" as const;
  private readonly process: GuardianProcess;
  readonly result: Promise<LocalProcessOutput>;

  constructor(input: SingleExecutableProcessInput) {
    this.process = new GuardianProcess(input);
    this.result = this.process.result;
  }

  stop(): void { this.process.stop(); }

  /** True only after verified guardian receipt, clean guardian exit and closed output. */
  get quiescent(): boolean { return this.process.quiescent; }
}
