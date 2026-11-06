import { BoundedLocalProcess, type LocalProcessOutput } from "./BoundedLocalProcess.js";

export type SingleExecutableProcessInput = {
  /** Absolute executable path. No shell parsing, translation or expansion. */
  executable: string;
  args: readonly string[];
  cwd: string;
  signal: AbortSignal;
};

/**
 * Darwin-only no-fork process primitive, not a shell or filesystem sandbox.
 * The trusted runtime must validate the canonical tool call, exact attempt,
 * grant, permission and approval, and acquire real capture before calling it.
 */
export class SingleExecutableProcess {
  private readonly process: BoundedLocalProcess;
  readonly result: Promise<LocalProcessOutput>;

  constructor(input: SingleExecutableProcessInput) {
    this.process = new BoundedLocalProcess(input);
    this.result = this.process.result;
  }

  stop(): void { this.process.stop(); }

  /** True only after observed closure of the one sandboxed PID and its output. */
  get quiescent(): boolean { return this.process.quiescent; }
}
