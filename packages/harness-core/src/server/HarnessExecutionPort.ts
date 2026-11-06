import type { DelegatedHarnessPort } from "@repo/runtime-kernel";
import { HarnessSessionManager } from "./HarnessSessionManager.js";

/** The local App Server and authenticated cloud bridge compose the same host implementation. */
export class HarnessExecutionPort implements DelegatedHarnessPort {
  constructor(private readonly sessions: HarnessSessionManager) {}
  open(
    input: Parameters<DelegatedHarnessPort["open"]>[0],
  ): ReturnType<DelegatedHarnessPort["open"]> {
    return this.sessions.open(input);
  }
  execute(
    input: Parameters<DelegatedHarnessPort["execute"]>[0],
  ): ReturnType<DelegatedHarnessPort["execute"]> {
    return this.sessions.execute(input);
  }
  control(
    command: Parameters<DelegatedHarnessPort["control"]>[0],
  ): ReturnType<DelegatedHarnessPort["control"]> {
    return this.sessions.control(command);
  }
  awaitQuiescence(
    input: Parameters<DelegatedHarnessPort["awaitQuiescence"]>[0],
  ): ReturnType<DelegatedHarnessPort["awaitQuiescence"]> {
    return this.sessions.awaitQuiescence(input);
  }
}
