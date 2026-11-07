/** Bounded process output; lifecycle and physical exit remain owned by the guardian. */
export type LocalProcessOutput = {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  outputClosed: boolean;
};
